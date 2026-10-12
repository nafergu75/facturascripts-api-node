/**
 * Historial de declaraciones de la AEAT sobre BD real (B4, B5 y B6):
 *  - presentar congela lo presentado (casillas, datos, IBAN, tipo, número);
 *  - después se prepara una complementaria o sustitutiva, que toma lo ya
 *    ingresado ([29] del 111, [04] del 115, [70] del 303) o, en las
 *    informativas, propone solo los registros nuevos;
 *  - el número identificativo es único en la empresa y nunca se reutiliza;
 *  - ningún GET de los modelos escribe;
 *  - una fila presentada antes del historial pasa a ser la secuencia 1.
 *
 * Necesita MySQL. Los NIF son inventados (con su carácter de control).
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { prisma } from '../config/database';
import { letraNif } from '../utils/nif';
import { expenseInvoicesService } from '../services/expense-invoices.service';
import declaracionesAeatRoutes from '../routes/declaraciones-aeat.routes';
import borradoresAeatRoutes from '../routes/borradores-aeat.routes';
import taxModelsRoutes from '../routes/tax-models.routes';
import impuestosModuloRoutes from '../routes/impuestosModulo.routes';
import { errorMiddleware } from '../middleware/error.middleware';
import { ficheroRetenciones } from '../services/tax-models.service';
import { generarTxt303 } from '../services/impuestosModulo.service';
import { borrador347, fichero347 } from '../services/borradoresAeat.service';
import { contextoDeclaracion } from '../services/declaracionesAeat/declaraciones.service';

const E = `decl-aeat-${Date.now()}`;
const OTRA = `decl-aeat-otra-${Date.now()}`;
const dni = (n: number) => `${n}${letraNif(n)}`;
let rol = 'contable';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/companies/:companyId', (req, _res, next) => {
    req.user = { userId: 'u-decl', roles: [rol], companies: [req.params.companyId], rolesPorEmpresa: { [req.params.companyId]: [rol] } } as never;
    req.companyId = req.params.companyId;
    next();
  });
  a.use('/companies/:companyId/tax-models', declaracionesAeatRoutes);
  a.use('/companies/:companyId/tax-models', borradoresAeatRoutes);
  a.use('/companies/:companyId/tax-models', taxModelsRoutes);
  a.use('/companies/:companyId/impuestos', impuestosModuloRoutes);
  a.use(errorMiddleware);
  return a;
}
const ruta = (r: string, empresa = E) => `/companies/${empresa}${r}`;

let numVenta = 0;
async function venta(companyId: string, customerId: string, fecha: string, base: number, iva: number, tipoOperacion = 'NACIONAL') {
  numVenta += 1;
  await prisma.incomeInvoice.create({
    data: {
      companyId,
      customerId,
      serie: 'D',
      numero: numVenta,
      numeroCompleto: `D-${numVenta}`,
      fechaEmision: fecha,
      fechaVencimiento: fecha,
      tipoOperacion,
      baseTotal: base,
      ivaTotal: iva,
      totalFactura: base + iva,
      lineas: { create: [{ descripcion: 'Venta', cantidad: 1, precioUnitario: base, baseLine: base, ivaImporte: iva, tipoIva: iva ? 21 : 0 }] },
    },
  });
}

let asesor = '';
const honorarios = (fecha: string, numero: string, precio: number) =>
  expenseInvoicesService.crearGasto(
    {
      companyId: E,
      proveedor: { id: asesor },
      numeroFacturaProveedor: numero,
      fechaEmision: fecha,
      tipoGasto: 'SERVICIO_PROFESIONAL',
      lineas: [{ descripcion: 'Asesoría', cantidad: 1, precioUnitario: precio, tipoIva: 21, tipoRetencion: 15 }],
    } as never,
    { contabilizar: 'POSTED' },
  );

/** Filas de ModeloImpuesto y declaraciones de la empresa (para ver que un GET no escribe). */
const escrito = async (companyId = E) => ({
  modelos: await prisma.modeloImpuesto.count({ where: { companyId } }),
  declaraciones: await prisma.declaracionAeat.count({ where: { companyId } }),
  opciones: JSON.stringify((await prisma.modeloImpuesto.findMany({ where: { companyId }, orderBy: { id: 'asc' } })).map((f) => [f.codigo, f.periodo, f.estado, f.casillas])),
});

beforeAll(async () => {
  for (const id of [E, OTRA]) {
    await prisma.company.create({ data: { id, name: `Declaraciones ${id}`, fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
    await prisma.legalConfig.create({
      data: { companyId: id, denominacion: 'Declaraciones Turia, S.L.', nif: 'B46000006', telefono: '961 23 45 67', personaContacto: 'García Pérez Ana', cnae: '4646' },
    });
  }
  asesor = (await prisma.supplier.create({ data: { companyId: E, nombreFiscal: 'Asesora Prueba', nifCif: dni(20000003), cp: '46001' } })).id;
  const cli = await prisma.customer.create({ data: { companyId: E, nombreFiscal: 'Distribuciones Peña, S.L.', nifCif: 'B12345674', pais: 'ES', cp: '46001' } });
  await venta(E, cli.id, '2026-02-10', 4000, 840);
  await venta(E, cli.id, '2026-05-10', 1000, 210);
  await honorarios('2026-02-15', 'H-1', 1000); // 111 del 1T: 150 €
});

describe('B6: los GET no escriben', () => {
  it('pantallas, ficheros, borradores e historial de todos los modelos', async () => {
    await request(app()).post(ruta('/tax-models/347/declaraciones/numero')).send({ ejercicio: 2026 }); // un número para poder bajar el 347
    const antes = await escrito();
    const gets = [
      '/tax-models/303?ejercicio=2026&periodo=2T',
      '/tax-models/111?ejercicio=2026&periodo=1T',
      '/tax-models/115?ejercicio=2026&periodo=1T',
      '/tax-models/190?ejercicio=2026',
      '/tax-models/349?ejercicio=2026&periodo=2T',
      '/tax-models/180?ejercicio=2026',
      '/tax-models/202?ejercicio=2026&periodo=1P',
      '/tax-models/111/fichero?ejercicio=2026&periodo=1T',
      '/impuestos/borradores/347?ejercicio=2026',
      '/impuestos/borradores/347/fichero?ejercicio=2026',
      '/impuestos/borradores/390?ejercicio=2026',
      '/impuestos/borradores/200?ejercicio=2026',
      '/tax-models/303/declaraciones?ejercicio=2026&periodo=2T',
      '/tax-models/347/declaraciones?ejercicio=2026',
      '/impuestos/modelos/cal-303-2026-2T',
      '/impuestos/modelos/cal-303-2026-2T/txt',
    ];
    for (const g of gets) {
      const r = await request(app()).get(ruta(g));
      expect([g, r.status < 500]).toEqual([g, true]);
    }
    expect(await escrito()).toEqual(antes);
  });

  it('solo lectura puede ver el historial pero no presentar ni pedir número', async () => {
    rol = 'solo-lectura';
    try {
      expect((await request(app()).get(ruta('/tax-models/111/declaraciones?ejercicio=2026&periodo=1T'))).status).toBe(200);
      expect((await request(app()).post(ruta('/tax-models/111/presentado')).send({ ejercicio: 2026, periodo: '1T', justificante: { numero: '1112026000001', fecha: '2026-04-15' } })).status).toBe(403);
      expect((await request(app()).post(ruta('/tax-models/349/declaraciones/numero')).send({ ejercicio: 2026, periodo: '2T' })).status).toBe(403);
      expect((await request(app()).post(ruta('/tax-models/111/declaraciones/rectificacion')).send({ ejercicio: 2026, periodo: '1T', tipo: 'C' })).status).toBe(403);
    } finally {
      rol = 'contable';
    }
  });
});

describe('190: la lista de perceptores de la complementaria es de Nóminas', () => {
  it('sin nominas:read el historial no trae los perceptores (ni sus importes), y elegirlos pide nominas:write', async () => {
    const pres = await request(app()).post(ruta('/tax-models/190/presentado')).send({ ejercicio: 2026, periodo: '0A', justificante: { numero: '1902026111111', fecha: '2027-01-20' } });
    expect(pres.status).toBe(200);
    expect((await request(app()).post(ruta('/tax-models/190/declaraciones/rectificacion')).send({ ejercicio: 2026, periodo: '0A', tipo: 'C' })).status).toBe(201);
    // Con Nóminas (contable): la lista con nombre e importe.
    const conNominas = await request(app()).get(ruta('/tax-models/190/declaraciones?ejercicio=2026'));
    expect(conNominas.status).toBe(200);
    expect(conNominas.body.data.registros).toEqual([expect.objectContaining({ nombre: expect.any(String), importe: 1000 })]);
    rol = 'solo-lectura';
    try {
      const r = await request(app()).get(ruta('/tax-models/190/declaraciones?ejercicio=2026'));
      expect(r.status).toBe(200);
      expect(r.body.data.registros).toBeNull();
      expect(r.body.data.enCurso.registros).toBeNull();
      expect(r.body.data.avisoRegistros).toMatch(/perceptores del 190 es de Nóminas/);
      expect(JSON.stringify(r.body.data)).not.toMatch(/Asesora Prueba|profesional:/);
    } finally {
      rol = 'contable';
    }
    // Con impuestos:write pero sin nóminas no se eligen perceptores.
    const soloImpuestos = express();
    soloImpuestos.use(express.json());
    soloImpuestos.use('/companies/:companyId', (req, _res, next) => {
      req.user = { userId: 'u-imp', roles: ['solo-lectura'], permisosPorEmpresa: { [req.params.companyId]: ['impuestos:read', 'impuestos:write'] }, companies: [req.params.companyId], rolesPorEmpresa: { [req.params.companyId]: ['solo-lectura'] } } as never;
      req.companyId = req.params.companyId;
      next();
    });
    soloImpuestos.use('/companies/:companyId/tax-models', declaracionesAeatRoutes);
    soloImpuestos.use(errorMiddleware);
    expect((await request(soloImpuestos).put(ruta('/tax-models/190/declaraciones/rectificacion/registros')).send({ ejercicio: 2026, periodo: '0A', registros: [] })).status).toBe(403);
    // Se cancela para no tocar el resto de pruebas.
    expect((await request(app()).delete(ruta('/tax-models/190/declaraciones/rectificacion?ejercicio=2026&periodo=0A'))).status).toBe(200);
  });
});

describe('B4: 111 complementaria', () => {
  it('presentado y congelado; la complementaria lleva [29] con lo ya ingresado y el justificante', async () => {
    const p = await request(app()).post(ruta('/tax-models/111/presentado')).send({ ejercicio: 2026, periodo: '1T', justificante: { numero: '1112026000001', fecha: '2026-04-15' } });
    expect(p.status).toBe(200);
    expect(p.body.data.declaraciones[0]).toMatchObject({ secuencia: 1, tipo: 'N', estado: 'presentada', resultado: 150 });
    const congelado = (await ficheroRetenciones(E, '111', 2026, '1T')).contenido;
    expect(Number(congelado.slice(328 + 486, 328 + 503)) / 100).toBe(150); // [28]
    // Presentado: ni opciones ni facturas nuevas en el trimestre (la app las bloquea).
    expect((await request(app()).put(ruta('/tax-models/111/opciones')).send({ ejercicio: 2026, periodo: '1T', formaPago: 'U' })).status).toBe(403);
    await expect(honorarios('2026-03-20', 'H-2', 1000)).rejects.toMatchObject({ statusCode: 409 });

    // Con la complementaria en preparación el trimestre vuelve a admitir la factura olvidada.
    const c = await request(app()).post(ruta('/tax-models/111/declaraciones/rectificacion')).send({ ejercicio: 2026, periodo: '1T', tipo: 'C' });
    expect(c.status).toBe(201);
    await honorarios('2026-03-20', 'H-2', 1000);
    expect(c.body.data).toMatchObject({ estado: 'en-curso', enCurso: { tipo: 'C', justificanteAnterior: '1112026000001', resultadoAnterior: 150 } });
    const pantalla = (await request(app()).get(ruta('/tax-models/111?ejercicio=2026&periodo=1T'))).body.data;
    expect(pantalla.formulario.liquidacion).toMatchObject({ complementaria: true, justificanteAnterior: '1112026000001' });
    const txt = (await ficheroRetenciones(E, '111', 2026, '1T')).contenido;
    const casilla = (pos: number) => Number(txt.slice(328 + pos - 1, 328 + pos - 1 + 17)) / 100;
    expect([casilla(487), casilla(504), casilla(521)]).toEqual([300, 150, 150]); // [28], [29], [30]

    // La sustitutiva no la admite el 111.
    expect((await request(app()).post(ruta('/tax-models/111/declaraciones/rectificacion')).send({ ejercicio: 2026, periodo: '1T', tipo: 'S' })).status).toBe(400);
    // Se presenta la complementaria: secuencia 2.
    const p2 = await request(app()).post(ruta('/tax-models/111/presentado')).send({ ejercicio: 2026, periodo: '1T', justificante: { numero: '1112026000002', fecha: '2026-04-18' } });
    expect(p2.body.data.declaraciones.map((d: { secuencia: number; tipo: string; resultado: number }) => [d.secuencia, d.tipo, d.resultado])).toEqual([
      [1, 'N', 150],
      [2, 'C', 150],
    ]);
    // Una segunda complementaria resta lo ingresado con las dos.
    const c2 = await request(app()).post(ruta('/tax-models/111/declaraciones/rectificacion')).send({ ejercicio: 2026, periodo: '1T', tipo: 'C' });
    expect(c2.body.data.enCurso).toMatchObject({ justificanteAnterior: '1112026000002', resultadoAnterior: 300 });
    // Cancelada: vuelve a lo presentado (la segunda complementaria).
    expect((await request(app()).delete(ruta('/tax-models/111/declaraciones/rectificacion?ejercicio=2026&periodo=1T'))).status).toBe(200);
    expect((await contextoDeclaracion(E, '111', 2026, '1T')).congelada).toBe(true);
    expect(Number((await ficheroRetenciones(E, '111', 2026, '1T')).contenido.slice(328 + 503, 328 + 520)) / 100).toBe(150); // [29]
  });
});

describe('B4: 303 rectificativa', () => {
  it('[70] con el [69] de la presentada, marca de rectificativa y justificante en la página 3', async () => {
    const p = await request(app()).post(ruta('/tax-models/303/presentado')).send({ ejercicio: 2026, periodo: '2T', justificante: { numero: '3032026000001', fecha: '2026-07-15' } });
    expect(p.status).toBe(200);
    expect(p.body.data.declaraciones[0]).toMatchObject({ tipo: 'N', resultado: 210 });
    await prisma.incomeInvoice.create({
      data: {
        companyId: E,
        customerId: (await prisma.customer.findFirstOrThrow({ where: { companyId: E } })).id,
        serie: 'D',
        numero: 900,
        numeroCompleto: 'D-900',
        fechaEmision: '2026-06-01',
        fechaVencimiento: '2026-06-01',
        tipoOperacion: 'NACIONAL',
        baseTotal: 500,
        ivaTotal: 105,
        totalFactura: 605,
        lineas: { create: [{ descripcion: 'Venta olvidada', cantidad: 1, precioUnitario: 500, baseLine: 500, ivaImporte: 105, tipoIva: 21 }] },
      },
    });
    // Congelada: la factura nueva no entra.
    const leer = (txt: string, pos: number) => txt.slice(txt.indexOf('<T30303000>') + pos - 1, txt.indexOf('<T30303000>') + pos - 1 + 17);
    expect(Number(leer((await generarTxt303(E, 2026, '2T')).contenido, 408)) / 100).toBe(210); // [71]

    const r = await request(app()).post(ruta('/tax-models/303/declaraciones/rectificacion')).send({ ejercicio: 2026, periodo: '2T', tipo: 'C' });
    expect(r.status).toBe(201);
    expect(r.body.data.enCurso).toMatchObject({ tipo: 'C', tipoTexto: 'rectificativa', justificanteAnterior: '3032026000001', resultadoAnterior: 210 });
    const pantalla = (await request(app()).get(ruta('/tax-models/303?ejercicio=2026&periodo=2T'))).body.data;
    expect(pantalla.rectificativa).toEqual({ justificanteAnterior: '3032026000001' });
    const de = (n: string) => pantalla.casillas303.find((c: { numero: string }) => c.numero === n)?.valor;
    expect([de('69'), de('70'), de('71')]).toEqual([315, 210, 105]);
    const txt = (await generarTxt303(E, 2026, '2T')).contenido;
    const p3 = txt.slice(txt.indexOf('<T30303000>'));
    expect(p3.slice(425, 426)).toBe('X'); // rectificativa
    expect(p3.slice(426, 439)).toBe('3032026000001'); // justificante anterior
    expect(p3.slice(457, 458)).toBe('X'); // motivo: rectificaciones
    expect(Number(leer(txt, 357)) / 100).toBe(210); // [70]
  });
});

describe('B4: 303 presentado congelado con los datos de la empresa y rectificativa con [111]', () => {
  it('el TXT presentado sigue con el NIF y la razón social de entonces; la rectificativa negativa lleva la DID', async () => {
    const cli = await prisma.customer.create({ data: { companyId: OTRA, nombreFiscal: 'Viveros Peña, S.L.', nifCif: 'B12345674', pais: 'ES', cp: '46001' } });
    await venta(OTRA, cli.id, '2026-02-10', 8047.62, 1690);
    const p = await request(app()).post(ruta('/tax-models/303/presentado', OTRA)).send({ ejercicio: 2026, periodo: '1T', justificante: { numero: '3032026000101', fecha: '2026-04-15' } });
    expect(p.status).toBe(200);
    const presentado = (await generarTxt303(OTRA, 2026, '1T')).contenido;
    const p1 = (txt: string) => txt.slice(txt.indexOf('<T30301000>'));
    expect(p1(presentado).slice(13, 102).trimEnd()).toBe('B46000006DECLARACIONES TURIA SL');

    // Cambian la denominación y el NIF: lo presentado no cambia (pantalla y fichero).
    await prisma.legalConfig.update({ where: { companyId: OTRA }, data: { nif: 'A10952364', denominacion: 'Otra Razón Distinta, S.A.' } });
    try {
      expect((await generarTxt303(OTRA, 2026, '1T')).contenido).toBe(presentado);
      const pantalla = (await request(app()).get(ruta('/tax-models/303?ejercicio=2026&periodo=1T', OTRA))).body.data;
      expect(JSON.stringify(pantalla)).not.toMatch(/OTRA RAZON|A10952364/);
    } finally {
      await prisma.legalConfig.update({ where: { companyId: OTRA }, data: { nif: 'B46000006', denominacion: 'Declaraciones Turia, S.L.' } });
    }

    // Rectificativa con una compra olvidada: [69] 640, [70] 1690, [71] -1050 y [111] 1050, tipo N.
    expect((await request(app()).post(ruta('/tax-models/303/declaraciones/rectificacion', OTRA)).send({ ejercicio: 2026, periodo: '1T', tipo: 'C' })).status).toBe(201);
    const prov = await prisma.supplier.create({ data: { companyId: OTRA, nombreFiscal: 'Suministros Olvidados SL', nifCif: 'B87654323', cp: '46001' } });
    await expenseInvoicesService.crearGasto(
      { companyId: OTRA, proveedor: { id: prov.id }, numeroFacturaProveedor: 'OLV-1', fechaEmision: '2026-03-01', tipoGasto: 'SERVICIO_PROFESIONAL', lineas: [{ descripcion: 'Compra olvidada', cantidad: 1, precioUnitario: 5000, tipoIva: 21, tipoRetencion: 0 }] } as never,
      { contabilizar: 'POSTED' },
    );
    const sinCuenta = await request(app()).get(ruta('/impuestos/modelos/cal-303-2026-1T/txt', OTRA));
    expect((await request(app()).get(ruta('/tax-models/303?ejercicio=2026&periodo=1T', OTRA))).body.data.errores.join(' ')).toMatch(/\[111\]/);
    expect(sinCuenta.status).toBeGreaterThanOrEqual(400);
    await prisma.bankAccount.create({ data: { companyId: OTRA, iban: 'ES9121000418450200051332', subcuentaCodigo: '572000' } });
    const txt = (await generarTxt303(OTRA, 2026, '1T')).contenido;
    const p3 = txt.slice(txt.indexOf('<T30303000>'));
    const imp = (pos: number) => (p3[pos - 1] === 'N' ? -1 : 1) * Number(p3.slice(pos - 1 + (p3[pos - 1] === 'N' ? 1 : 0), pos - 1 + 17)) / 100;
    expect([imp(340), imp(357), imp(408), imp(441)]).toEqual([640, 1690, -1050, 1050]); // [69], [70], [71], [111]
    expect(p1(txt)[12]).toBe('N');
    const did = txt.slice(txt.indexOf('<T303DID00>'));
    expect(txt.indexOf('<T303DID00>')).toBeGreaterThan(0);
    expect(did.slice(22, 46)).toBe('ES9121000418450200051332');
  });
});

describe('B4 y B5: 347 normal, complementaria y sustitutiva', () => {
  it('la complementaria propone solo los declarados nuevos; los números no se repiten ni se reutilizan', async () => {
    // El número de la normal ya se pidió (test de los GET): se reutiliza al presentar.
    const p = await request(app()).post(ruta('/tax-models/347/presentado')).send({ ejercicio: 2026, justificante: { numero: '3472026000001', fecha: '2027-02-20' } });
    expect(p.status).toBe(200);
    expect(p.body.data.declaraciones[0]).toMatchObject({ numero: '3472026000001', numeroRegistros: 1 });
    // Pantalla y fichero congelados.
    const congelada = await borrador347(E, 2026);
    expect(congelada.congelada).toBe(true);
    expect(congelada.advertencias[0]).toMatch(/^Presentada \(justificante 3472026000001/);
    const ficheroPresentado = (await fichero347(E, 2026)).contenido;

    // Un cliente nuevo que pasa del umbral.
    const nuevo = await prisma.customer.create({ data: { companyId: E, nombreFiscal: 'Cliente Olvidado SL', nifCif: 'B87654323', pais: 'ES', cp: '28001' } });
    await venta(E, nuevo.id, '2026-09-01', 4000, 840);
    expect((await fichero347(E, 2026)).contenido).toBe(ficheroPresentado);

    const c = await request(app()).post(ruta('/tax-models/347/declaraciones/rectificacion')).send({ ejercicio: 2026, tipo: 'C' });
    expect(c.status).toBe(201);
    expect(c.body.data.enCurso).toMatchObject({ tipo: 'C', numero: '3472026000002', justificanteAnterior: '3472026000001', registros: ['B87654323|B'] });
    const h = await request(app()).get(ruta('/tax-models/347/declaraciones?ejercicio=2026'));
    expect(h.body.data.registros.map((r: { clave: string; presentado: boolean; incluido: boolean }) => [r.clave, r.presentado, r.incluido])).toEqual([
      ['B12345674|B', true, false],
      ['B87654323|B', false, true],
    ]);
    const lineas = (await fichero347(E, 2026)).contenido.split('\r\n').filter(Boolean);
    expect(lineas).toHaveLength(2);
    expect(lineas[0].slice(107, 135)).toBe('3472026000002' + 'C ' + '3472026000001');
    expect(lineas[1].slice(17, 26)).toBe('B87654323');

    // Se cambia a sustitutiva: la complementaria queda anulada y su número no se reutiliza.
    await request(app()).delete(ruta('/tax-models/347/declaraciones/rectificacion?ejercicio=2026'));
    const s = await request(app()).post(ruta('/tax-models/347/declaraciones/rectificacion')).send({ ejercicio: 2026, tipo: 'S' });
    expect(s.body.data.enCurso).toMatchObject({ tipo: 'S', numero: '3472026000003' });
    const sus = (await fichero347(E, 2026)).contenido.split('\r\n').filter(Boolean);
    expect(sus).toHaveLength(3);
    expect(sus[0].slice(107, 135)).toBe('3472026000003' + ' S' + '3472026000001');
    // Otra empresa empieza su propia numeración.
    expect((await request(app()).post(ruta('/tax-models/347/declaraciones/numero', OTRA)).send({ ejercicio: 2026 })).body.data.enCurso.numero).toBe('3472026000001');

    // Se presenta una complementaria y después se prepara una sustitutiva: cita la
    // original (no la complementaria) y avisa de las dos bajas que hay que hacer en la sede.
    expect((await request(app()).delete(ruta('/tax-models/347/declaraciones/rectificacion?ejercicio=2026'))).status).toBe(200);
    const c2 = await request(app()).post(ruta('/tax-models/347/declaraciones/rectificacion')).send({ ejercicio: 2026, tipo: 'C' });
    expect(c2.body.data.enCurso).toMatchObject({ tipo: 'C', numero: '3472026000004', justificanteAnterior: '3472026000001', bajas: [], aviso: null });
    expect((await request(app()).post(ruta('/tax-models/347/presentado')).send({ ejercicio: 2026, justificante: { numero: '3472026000004', fecha: '2027-02-25' } })).status).toBe(200);
    const s2 = await request(app()).post(ruta('/tax-models/347/declaraciones/rectificacion')).send({ ejercicio: 2026, tipo: 'S' });
    expect(s2.status).toBe(201);
    expect(s2.body.data.enCurso).toMatchObject({ tipo: 'S', numero: '3472026000005', justificanteAnterior: '3472026000001', bajas: ['3472026000001', '3472026000004'] });
    expect(s2.body.data.enCurso.aviso).toMatch(/da de baja en la sede de la AEAT la declaración 3472026000001.*Baja de declaración por sustitución.*la complementaria 3472026000004/);
    const s2txt = (await fichero347(E, 2026)).contenido.split('\r\n').filter(Boolean);
    expect(s2txt[0].slice(107, 135)).toBe('3472026000005' + ' S' + '3472026000001');
    expect(s2txt).toHaveLength(3); // todos los declarados
  });
});

describe('B4: complementaria de una informativa con un registro que aparece después de prepararla', () => {
  it('el nuevo entra solo en la propuesta y en el fichero; si se desmarca, se respeta', async () => {
    const p = await request(app()).post(ruta('/tax-models/347/presentado', OTRA)).send({ ejercicio: 2026, justificante: { numero: '3472026000001', fecha: '2027-02-20' } });
    expect(p.status).toBe(200);
    const presentados = p.body.data.declaraciones[0].numeroRegistros as number;
    const c = await request(app()).post(ruta('/tax-models/347/declaraciones/rectificacion', OTRA)).send({ ejercicio: 2026, tipo: 'C' });
    expect(c.status).toBe(201);
    expect(c.body.data.enCurso.registros).toEqual([]); // al prepararla no había nada nuevo

    // Se registra ahora la factura olvidada: el cliente nuevo pasa del umbral.
    const nuevo = await prisma.customer.create({ data: { companyId: OTRA, nombreFiscal: 'Olvidado Después SL', nifCif: 'B87654323', pais: 'ES', cp: '28001' } });
    await venta(OTRA, nuevo.id, '2026-10-01', 4000, 840);
    const h = (await request(app()).get(ruta('/tax-models/347/declaraciones?ejercicio=2026', OTRA))).body.data;
    const marcas = Object.fromEntries(h.registros.map((r: { clave: string; incluido: boolean }) => [r.clave, r.incluido]));
    expect(marcas['B87654323|B']).toBe(true);
    expect(Object.values(marcas).filter(Boolean)).toHaveLength(1);
    expect(h.registros).toHaveLength(presentados + 1);
    const lineas = (await fichero347(OTRA, 2026)).contenido.split('\r\n').filter(Boolean);
    expect(lineas).toHaveLength(2);
    expect(lineas[1].slice(17, 26)).toBe('B87654323');

    // La persona lo desmarca: ya lo ha visto y no vuelve a proponerse.
    const d = await request(app()).put(ruta('/tax-models/347/declaraciones/rectificacion/registros', OTRA)).send({ ejercicio: 2026, registros: [] });
    expect(d.status).toBe(200);
    expect(d.body.data.registros.find((r: { clave: string }) => r.clave === 'B87654323|B').incluido).toBe(false);
    expect((await request(app()).get(ruta('/impuestos/borradores/347/fichero?ejercicio=2026', OTRA))).status).toBe(400);
  });
});

describe('B4: 390 sustitutiva y 200 rectificativa', () => {
  it('marca y justificante de la anterior en la página 1', async () => {
    const p = await request(app()).post(ruta('/tax-models/390/presentado')).send({ ejercicio: 2026, justificante: { numero: '3902026000001', fecha: '2027-01-28' } });
    expect(p.status).toBe(200);
    expect((await request(app()).post(ruta('/tax-models/390/declaraciones/rectificacion')).send({ ejercicio: 2026, tipo: 'C' })).status).toBe(400);
    expect((await request(app()).post(ruta('/tax-models/390/declaraciones/rectificacion')).send({ ejercicio: 2026, tipo: 'S' })).status).toBe(201);
    const b = (await request(app()).get(ruta('/impuestos/borradores/390?ejercicio=2026'))).body.data;
    const p1 = b.paginas.find((x: { codigo: string }) => x.codigo === '01000').linea as string;
    expect(p1.slice(132, 147)).toBe('1' + '0' + '3902026000001');

    // Sin la anterior en la app hay que decir lo que se ingresó: si no, se pediría otra vez entero.
    const sin = await request(app()).post(ruta('/tax-models/200/declaraciones/rectificacion')).send({ ejercicio: 2026, tipo: 'C', justificanteAnterior: '2002026000001' });
    expect(sin.status).toBe(400);
    expect(sin.body.message).toMatch(/lo que se ingresó/);
    // El 200 de prueba no cuadra con unas cuentas vacías, pero la rectificativa se marca igual.
    const ctx200 = await request(app())
      .post(ruta('/tax-models/200/declaraciones/rectificacion'))
      .send({ ejercicio: 2026, tipo: 'C', justificanteAnterior: '2002026000001', resultadoAnterior: 1540 });
    expect(ctx200.status).toBe(201);
    const d200 = (await request(app()).get(ruta('/impuestos/borradores/200?ejercicio=2026'))).body.data;
    const pag = d200.paginas.find((x: { codigo: string }) => x.codigo === '01000').linea as string;
    // Posición 149: rectificativa; 150-162: justificante; 163: motivo «Rectificaciones».
    expect(pag.slice(148, 163)).toBe('1' + '2002026000001' + '1');
    expect(d200.liquidacion.resultadoAnterior).toBe(1540);
    const p14b = d200.paginas.find((x: { codigo: string }) => x.codigo === '14B00').linea as string;
    expect(Number(p14b.slice(1084, 1101)) / 100).toBe(1540); // [01578]
    expect(d200.advertencias.join(' ')).toMatch(/Sociedades WEB/);
  });
});

describe('B4: fila presentada de antes del historial', () => {
  it('pasa a ser la secuencia 1 al preparar la complementaria, con su justificante', async () => {
    await prisma.modeloImpuesto.create({
      data: {
        companyId: E,
        codigo: '115',
        ejercicio: 2026,
        periodo: '2T',
        estado: 'presentado',
        casillas: { '01_perceptores': 1, '02_base': 1000, '03_retenciones': 190, '04_anteriores': 0, '05_resultado': 190, config_nif: 'B46000006', config_razon_social: 'Declaraciones Turia SL' } as never,
        datos: { justificante: { numero: '1152026000009', fecha: '2026-07-10' } } as never,
      },
    });
    const h = await request(app()).get(ruta('/tax-models/115/declaraciones?ejercicio=2026&periodo=2T'));
    expect(h.body.data).toMatchObject({ estado: 'presentada', presentadoSinHistorial: true, declaraciones: [] });
    const c = await request(app()).post(ruta('/tax-models/115/declaraciones/rectificacion')).send({ ejercicio: 2026, periodo: '2T', tipo: 'C' });
    expect(c.status).toBe(201);
    expect(c.body.data.declaraciones[0]).toMatchObject({ secuencia: 1, tipo: 'N', estado: 'presentada', justificante: '1152026000009' });
    expect(c.body.data.enCurso).toMatchObject({ tipo: 'C', justificanteAnterior: '1152026000009', resultadoAnterior: 190 });
  });

  it('sin la anterior en la app: hay que dar su número y lo ingresado', async () => {
    const r = await request(app()).post(ruta('/tax-models/115/declaraciones/rectificacion')).send({ ejercicio: 2026, periodo: '3T', tipo: 'C' });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/escribe el número de la declaración anterior/);
    const ok = await request(app()).post(ruta('/tax-models/115/declaraciones/rectificacion')).send({ ejercicio: 2026, periodo: '3T', tipo: 'C', justificanteAnterior: '1152026000010', resultadoAnterior: 50 });
    expect(ok.status).toBe(201);
    expect(ok.body.data.enCurso).toMatchObject({ justificanteAnterior: '1152026000010', resultadoAnterior: 50 });
  });
});
