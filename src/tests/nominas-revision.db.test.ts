/**
 * Arreglos de la revision de nominas, sobre BD real:
 *  - el pago de los liquidos no saca una nomina de un 111 presentado ni la mete
 *    en uno (su IRPF se declararia dos veces); anular el pago restaura la fecha
 *    de pago de antes; el 190 cuadra contra lo presentado, no contra el recalculo;
 *  - seguros sociales: una nomina que llega tarde se paga con la complementaria
 *    contra la 476 (la 642 no sale doble) y no se anula una nomina cuya SS ya
 *    se pago;
 *  - el pago del 111 usa lo presentado, no se hace con nominas en borrador y
 *    lleva el IRPF del resumen antiguo a su propia 4751; un mes con dos
 *    resumenes antiguos avisa;
 *  - los asientos y el plan no llevan el nombre ni el NIF de los trabajadores;
 *  - auditoria del alta y la edicion de nominas y de las descargas en Excel;
 *  - un PDF borrado ya no se descarga; ejercicio de devengo de los atrasos;
 *  - el lector de gastos deja registrar el recibo de la SS si la empresa no
 *    tiene trabajadores.
 *
 * Necesita MySQL (en GitHub Actions lo levanta el workflow de tests). Los NIF
 * son inventados (numeros con su letra de control calculada).
 */
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { promises as fsp } from 'fs';
import * as path from 'path';
import express from 'express';
import request from 'supertest';
import * as XLSX from 'xlsx';
import { prisma } from '../config/database';
import { letraNif } from '../utils/nif';
import { anularNominas, borrarNomina, confirmarImportacion, contabilizarNominas, crearNomina, actualizarNomina } from '../services/nominas.service';
import { crearEmpleado } from '../services/empleados.service';
import { calcularModelo190, periodoFiscal, retencionesTrabajo } from '../services/nominas/fiscal';
import { anularPagoNominas, importePago111, pagarModelo111, pagarNominas } from '../services/nominas/tesoreria';
import { obtenerSegurosSociales, pagarSegurosSociales } from '../services/nominas/segurosSociales';
import { anularDocumentoNominas, descargarDocumentoNominas, subirDocumentoNominas } from '../services/nominas/documentos';
import { filasDesdeJson } from '../services/nominas/lector';
import { taxModelsService } from '../services/tax-models.service';
import { accountingEngineController } from '../controllers/accounting-engine.controller';
import nominasRoutes from '../routes/nominas.routes';
import gastosRoutes from '../routes/gastos-extractor.routes';
import { errorMiddleware } from '../middleware/error.middleware';

const SUFIJO = Date.now();
const R1 = `nomrev1-${SUFIJO}`; // 111 presentado y fecha de pago
const R2 = `nomrev2-${SUFIJO}`; // seguros sociales
const R3 = `nomrev3-${SUFIJO}`; // pago del 111
const R4 = `nomrev4-${SUFIJO}`; // auditoria, PDF, atrasos y lector de gastos
const R5 = `nomrev5-${SUFIJO}`; // empresa sin trabajadores
const nif = (n: number) => `${String(n).padStart(8, '0')}${letraNif(n)}`;
const bancos: Record<string, string> = {};

const NOMINA = { brutoDinerario: 2000, ssTrabajador: 127, irpf: 300, liquido: 1573, ssEmpresa: 600 };
const asiento = (id: string) => prisma.journalEntry.findUniqueOrThrow({ where: { id }, include: { lineas: true } });
const porCuenta = (lineas: Array<{ accountCode: string; debe: unknown; haber: unknown }>) =>
  Object.fromEntries(lineas.map((l) => [l.accountCode, [Number(l.debe), Number(l.haber)]]));
const presentar111 = (companyId: string, ejercicio: number, periodo: string, retencionesTrabajo: number) =>
  prisma.modeloImpuesto.upsert({
    where: { companyId_codigo_ejercicio_periodo: { companyId, codigo: '111', ejercicio, periodo } },
    update: {},
    create: {
      companyId,
      codigo: '111',
      ejercicio,
      periodo,
      estado: 'presentado',
      origen: 'autorrelleno',
      casillas: { '03_retenciones_trabajo': retencionesTrabajo, '06_ingresos_a_cuenta': 0, '09_retenciones_actividades': 0, '28_total_retenciones': retencionesTrabajo, '30_resultado': retencionesTrabajo },
    },
  });

function app(companyId: string, rol = 'contable') {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    req.user = { userId: 'u-revision', roles: [rol], companies: [companyId], rolesPorEmpresa: { [companyId]: [rol] } } as never;
    req.companyId = companyId;
    next();
  });
  a.use('/nominas', nominasRoutes);
  a.use('/gastos-extractor', gastosRoutes);
  a.use(errorMiddleware);
  return a;
}
const binario = (res: NodeJS.ReadableStream & { setEncoding?: unknown }, cb: (e: Error | null, b: Buffer) => void) => {
  const trozos: Buffer[] = [];
  res.on('data', (c: Buffer) => trozos.push(c));
  res.on('end', () => cb(null, Buffer.concat(trozos)));
};

beforeAll(async () => {
  for (const id of [R1, R2, R3, R4, R5]) {
    await prisma.company.create({ data: { id, name: `Empresa ${id}`, fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
    bancos[id] = (await prisma.bankAccount.create({ data: { companyId: id, iban: `ES00000000000000000${String(Math.floor(Math.random() * 1e5)).padStart(5, '0')}`, bancoNombre: 'Banco Prueba', subcuentaCodigo: '572001' } })).id;
  }
});

afterAll(async () => {
  await fsp.rm(path.join(process.cwd(), 'storage', 'nominas', R4), { recursive: true, force: true });
});

describe('fecha de pago y 111 presentado (el IRPF no se declara dos veces)', () => {
  const emp: Record<string, string> = {};
  const nom: Record<string, string> = {};

  beforeAll(async () => {
    for (const [k, n] of [['A', 81000001], ['B', 81000002], ['C', 81000003]] as const) {
      emp[k] = (await crearEmpleado(R1, { nif: nif(n), nombre: `Persona ${k}`, apellidos: 'Revisión', provincia: '46', anioNacimiento: 1990 })).id;
    }
    nom.A12 = (await crearNomina(R1, { empleadoId: emp.A, ejercicio: 2026, mes: 12, ...NOMINA })).id;
    nom.B9 = (await crearNomina(R1, { empleadoId: emp.B, ejercicio: 2026, mes: 9, brutoDinerario: 1800, ssTrabajador: 114.3, irpf: 180, liquido: 1505.7, ssEmpresa: 540 })).id;
    nom.C8 = (await crearNomina(R1, { empleadoId: emp.C, ejercicio: 2026, mes: 8, brutoDinerario: 1500, ssTrabajador: 95.25, irpf: 120, liquido: 1284.75, ssEmpresa: 450 })).id;
    for (const mes of [8, 9, 12]) await contabilizarNominas(R1, 2026, mes);
  });

  const T3 = periodoFiscal(2026, '3T');
  const T4 = periodoFiscal(2026, '4T');

  it('sin 111 presentado, el pago mueve la nomina de trimestre; al anularlo vuelve a su fecha de pago de antes', async () => {
    const r = await pagarNominas(R1, 2026, 8, { fecha: '2026-10-07', cuentaBancariaId: bancos[R1] });
    expect(r.avisos.join(' ')).toMatch(/pasa del 111 del 3T\/2026 al de ese trimestre/);
    expect(await prisma.nomina.findUniqueOrThrow({ where: { id: nom.C8 } })).toMatchObject({ fechaPago: '2026-10-07', fechaPagoAnterior: '2026-08-31' });
    expect((await retencionesTrabajo(R1, T3)).casillas.retencionesDinerarias).toBe(180);

    const a = await anularPagoNominas(R1, 2026, 8);
    expect(a.avisos).toEqual([]);
    // La fecha del pago anulado ya no es real: vuelve a la de antes y al 111 del 3T.
    expect(await prisma.nomina.findUniqueOrThrow({ where: { id: nom.C8 } })).toMatchObject({ estado: 'CONTABILIZADA', fechaPago: '2026-08-31', fechaPagoAnterior: null });
    expect((await retencionesTrabajo(R1, T3)).casillas.retencionesDinerarias).toBe(300);
    expect((await retencionesTrabajo(R1, T4)).casillas.retencionesDinerarias).toBe(300);
  });

  it('con el 111 del 4T presentado, pagar en enero las nominas de diciembre no las saca del 4T (se avisa)', async () => {
    await presentar111(R1, 2026, '4T', 300);
    const r = await pagarNominas(R1, 2026, 12, { fecha: '2027-01-20', cuentaBancariaId: bancos[R1] });
    expect(r.avisos.join(' ')).toMatch(/111 del 4T\/2026 ya está presentado.*se mantiene su fecha de pago/);
    expect(await prisma.nomina.findUniqueOrThrow({ where: { id: nom.A12 } })).toMatchObject({ estado: 'PAGADA', fechaPago: '2026-12-31' });
    expect((await retencionesTrabajo(R1, periodoFiscal(2027, '1T'))).casillas.retencionesDinerarias).toBe(0);
    expect((await retencionesTrabajo(R1, T4)).casillas.retencionesDinerarias).toBe(300);
    // Anular ese pago tampoco la mueve.
    await anularPagoNominas(R1, 2026, 12);
    expect(await prisma.nomina.findUniqueOrThrow({ where: { id: nom.A12 } })).toMatchObject({ estado: 'CONTABILIZADA', fechaPago: '2026-12-31' });
  });

  it('no se mete una nomina en un 111 ya presentado: pagar las de septiembre en octubre da 409; en septiembre, bien', async () => {
    await expect(pagarNominas(R1, 2026, 9, { fecha: '2026-10-07', cuentaBancariaId: bancos[R1] })).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringMatching(/111 del 4T\/2026 ya está presentado/),
    });
    const r = await pagarNominas(R1, 2026, 9, { fecha: '2026-09-30', cuentaBancariaId: bancos[R1] });
    expect(r.avisos).toEqual([]);
  });

  it('borrador: avisa si entra en un 111 presentado y no deja cambiarlo de trimestre (409)', async () => {
    const extra = await crearNomina(R1, { empleadoId: emp.A, ejercicio: 2026, mes: 12, tipo: 'EXTRA', brutoDinerario: 500, irpf: 50, liquido: 450 });
    nom.A12x = extra.id;
    expect(extra.avisos.join(' ')).toMatch(/111 del 4T\/2026 ya está presentado/);
    await expect(actualizarNomina(R1, extra.id, { fechaPago: '2027-01-05' })).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/declararía dos veces/) });
  });

  it('el 190 cuadra contra el 111 PRESENTADO: la paga extra no presentada hace que no coincida', async () => {
    const m = await calcularModelo190(R1, 2026);
    expect(m.cuadre111.trimestres.find((t) => t.periodo === '4T')).toEqual({ periodo: '4T', retenciones: 300, fuente: 'presentado' });
    expect(m.cuadre111.trimestres.find((t) => t.periodo === '3T')).toMatchObject({ retenciones: 300, fuente: 'calculado' });
    expect(m.totales.retenciones).toBe(650);
    expect(m.cuadre111).toMatchObject({ total: 600, coincide: false });
    expect(m.avisos.join(' ')).toMatch(/no coinciden con la suma de los cuatro 111.*4T con lo presentado/);
    await borrarNomina(R1, nom.A12x);
    expect((await calcularModelo190(R1, 2026)).cuadre111.coincide).toBe(true);
  });

  it('los asientos, sus apuntes y el plan no llevan el nombre ni el NIF de los trabajadores', async () => {
    const asientos = await prisma.journalEntry.findMany({ where: { companyId: R1 }, include: { lineas: true } });
    expect(asientos.length).toBeGreaterThan(3);
    const plan = await prisma.chartOfAccounts.findMany({ where: { companyId: R1, codigo: { startsWith: '465' } } });
    // Lo que recibe un usuario de solo-lectura, ventas o tesoreria (contabilidad:read, sin nominas:read)
    // en GET /accounting/journal-entries?origen=NOMINA y NOMINA_PAGO.
    const diario = [
      ...(await accountingEngineController.listarAsientos(R1, { origen: 'NOMINA' })),
      ...(await accountingEngineController.listarAsientos(R1, { origen: 'NOMINA_PAGO' })),
    ];
    expect(diario.length).toBeGreaterThan(3);
    const texto = JSON.stringify([asientos, plan, diario]);
    const empleados = await prisma.empleado.findMany({ where: { companyId: R1 } });
    for (const e of empleados) {
      expect(texto).not.toContain(e.nif);
      expect(texto).not.toContain(e.nombre);
      expect(texto).toContain(`trabajador ${e.subcuenta465}`);
    }
  });
});

describe('seguros sociales: nomina que llega despues de pagar el RLC', () => {
  const emp: Record<string, string> = {};
  const nom: Record<string, string> = {};

  it('el RLC normal se paga con la SS de las nominas contabilizadas', async () => {
    for (const [k, n] of [['A', 82000001], ['B', 82000002]] as const) emp[k] = (await crearEmpleado(R2, { nif: nif(n), nombre: `Persona ${k}`, apellidos: 'SS' })).id;
    nom.A = (await crearNomina(R2, { empleadoId: emp.A, ejercicio: 2026, mes: 3, ...NOMINA })).id;
    await contabilizarNominas(R2, 2026, 3);
    const r = await pagarSegurosSociales(R2, 2026, 3, { fecha: '2026-04-30', cuentaBancariaId: bancos[R2] });
    expect(r).toMatchObject({ importe: 727, totalPrevisto: 727, diferencia: 0 });
  });

  it('contabilizar una nomina que llega tarde avisa de que su SS queda en la 476 hasta la complementaria', async () => {
    nom.B = (await crearNomina(R2, { empleadoId: emp.B, ejercicio: 2026, mes: 3, brutoDinerario: 1000, ssTrabajador: 60, irpf: 0, liquido: 940, ssEmpresa: 300 })).id;
    const r = await contabilizarNominas(R2, 2026, 3);
    expect(r.avisos.join(' ')).toMatch(/ya están pagados.*360,00 €.*476/);
  });

  it('no se anula una nomina cuya SS ya se pago (409); la que llego tarde, si', async () => {
    await expect(anularNominas(R2, 2026, 3, { nominaIds: [nom.A] })).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/anula antes el pago de los seguros sociales/) });
    await anularNominas(R2, 2026, 3, { nominaIds: [nom.B] });
    await contabilizarNominas(R2, 2026, 3);
  });

  it('la complementaria salda la 476 (no va a la 642): la 642 queda con la SS empresa de verdad y la 476 a cero', async () => {
    const c = await obtenerSegurosSociales(R2, 2026, 3, 'COMPLEMENTARIA');
    expect(c).toMatchObject({ estado: 'PENDIENTE', totalPrevisto: 360, cuotaObrera: 60, cuotaPatronal: 300, aPagar: 360 });
    const r = await pagarSegurosSociales(R2, 2026, 3, { tipo: 'COMPLEMENTARIA', totalRlc: 360, fecha: '2026-05-15', cuentaBancariaId: bancos[R2] });
    expect(porCuenta((await asiento(r.asiento.id)).lineas)).toEqual({ '476000': [360, 0], '572001': [0, 360] });
    const lineas = await prisma.journalEntryLine.findMany({ where: { companyId: R2, entry: { estado: { not: 'REVERSED' } } } });
    const saldo = (prefijo: string) => Math.round(lineas.filter((l) => l.accountCode.startsWith(prefijo)).reduce((a, l) => a + Number(l.debe) - Number(l.haber), 0) * 100) / 100;
    expect(saldo('642')).toBe(900);
    expect(saldo('476')).toBe(0);
  });
});

describe('pago del 111', () => {
  let emp: string;

  beforeAll(async () => {
    emp = (await crearEmpleado(R3, { nif: nif(83000001), nombre: 'Persona', apellidos: 'Cientoonce' })).id;
    await crearNomina(R3, { empleadoId: emp, ejercicio: 2026, mes: 4, ...NOMINA });
    await contabilizarNominas(R3, 2026, 4);
  });

  it('se paga lo presentado (280 €), no el recalculo (300 €), y cuadra con el cargo del banco', async () => {
    await presentar111(R3, 2026, '2T', 280);
    const imp = await importePago111(R3, periodoFiscal(2026, '2T'));
    expect(imp).toMatchObject({ fuente: 'presentado', total: 280, trabajoNominas: 280 });
    expect(imp.avisos.join(' ')).toMatch(/Se paga lo presentado.*saldría 300,00 €/);
    const cargo = await prisma.bankMovement.create({ data: { companyId: R3, cuentaBancariaId: bancos[R3], fecha: '2026-07-20', importe: -280, concepto: 'MODELO 111', origen: 'csv' } });
    const r = await pagarModelo111(R3, 2026, '2T', { movimientoId: cargo.id });
    expect(r).toMatchObject({ importe: 280, fuente: 'presentado' });
    expect(porCuenta((await asiento(r.asiento.id)).lineas)).toEqual({ '475101': [280, 0], '572001': [0, 280] });
  });

  it('no se paga con nominas del periodo en borrador; el IRPF del resumen antiguo va a su propia 4751; dos resumenes en un mes avisan', async () => {
    const borrador = await crearNomina(R3, { empleadoId: emp, ejercicio: 2026, mes: 8, brutoDinerario: 1500, irpf: 200, liquido: 1300 });
    await expect(pagarModelo111(R3, 2026, '3T', { fecha: '2026-10-15', cuentaBancariaId: bancos[R3] })).rejects.toMatchObject({ statusCode: 409 });
    await contabilizarNominas(R3, 2026, 8, [borrador.id]);
    // Julio solo con el resumen antiguo, grabado dos veces: cuenta el ultimo (150) y se avisa.
    await prisma.nominaResumen.create({ data: { companyId: R3, ejercicio: 2026, mes: 7, totalBruto: 1000, totalIRPF: 100, createdAt: new Date('2026-08-01T10:00:00Z') } });
    await prisma.nominaResumen.create({ data: { companyId: R3, ejercicio: 2026, mes: 7, totalBruto: 1200, totalIRPF: 150, createdAt: new Date('2026-08-02T10:00:00Z') } });
    const t = await retencionesTrabajo(R3, periodoFiscal(2026, '3T'));
    expect(t.casillas.retencionesDinerarias).toBe(350);
    expect(t.avisos.join(' ')).toMatch(/julio de 2026 tiene 2 resúmenes antiguos.*100,00 €, 150,00 €.*solo cuenta el último grabado \(150,00 €\)/);

    const r = await pagarModelo111(R3, 2026, '3T', { fecha: '2026-10-15', cuentaBancariaId: bancos[R3] });
    expect(r).toMatchObject({ importe: 350, trabajo: 350, trabajoResumenAntiguo: 150, cuentaResumenAntiguo: '475100' });
    expect(porCuenta((await asiento(r.asiento.id)).lineas)).toEqual({ '475101': [200, 0], '475100': [150, 0], '572001': [0, 350] });
  });

  it('el desglose trimestral del 190 sale de la misma fuente que sus totales (sin el resumen antiguo) y suma lo mismo', async () => {
    const m = await taxModelsService.generarModelo190(R3, 2026);
    const suma = Math.round(m.desgloseTrimestral.reduce((a: number, t: { cuota: number }) => a + t.cuota * 100, 0)) / 100;
    expect(m.totalRetenido).toBe(500);
    expect(suma).toBe(500);
    expect(m.desgloseTrimestral.map((t: { cuota: number }) => t.cuota)).toEqual([0, 300, 200, 0]);
  });
});

describe('auditoria, PDF borrados, atrasos y lector de gastos', () => {
  let emp: string;

  beforeAll(async () => {
    emp = (await crearEmpleado(R4, { nif: nif(84000001), nombre: 'Persona', apellidos: 'Auditada', provincia: '46', anioNacimiento: 1980, discapacidad: 1 })).id;
  });
  const auditoria = (action: string) => prisma.auditLog.findMany({ where: { companyId: R4, action } });

  it('el alta y la edicion a mano de una nomina quedan en la auditoria (con lo que cambia)', async () => {
    const alta = await request(app(R4)).post('/nominas').send({ empleadoId: emp, ejercicio: 2026, mes: 2, ...NOMINA });
    expect(alta.status).toBe(201);
    const id = alta.body.data.id as string;
    const [creada] = await auditoria('CREAR_NOMINA');
    expect(creada).toMatchObject({ resourceId: id, userId: 'u-revision', meta: expect.objectContaining({ irpf: 300, brutoDinerario: 2000 }) });

    const ed = await request(app(R4)).put(`/nominas/${id}`).send({ irpf: 320, liquido: 1553 });
    expect(ed.status).toBe(200);
    const [editada] = await auditoria('EDITAR_NOMINA');
    expect(editada.meta).toEqual({ empleadoId: emp, cambios: { irpf: { antes: 300, despues: 320 }, liquido: { antes: 1573, despues: 1553 } } });
  });

  it('las descargas en Excel del 190 por perceptor y del coste de personal quedan en la auditoria; el Excel del 190 no lleva la discapacidad', async () => {
    const x = await request(app(R4)).get('/nominas/190/2026/perceptores?formato=xlsx').buffer(true).parse(binario as never);
    expect(x.status).toBe(200);
    const filas = XLSX.utils.sheet_to_json<unknown[]>(XLSX.read(x.body as Buffer).Sheets.Perceptores, { header: 1 });
    expect(JSON.stringify(filas)).toContain('Auditada');
    expect(JSON.stringify(filas)).not.toMatch(/Discapacidad/i);
    expect(await auditoria('EXPORTAR_PERCEPTORES_190')).toEqual([expect.objectContaining({ resourceId: '2026', meta: expect.objectContaining({ registros: 1 }) })]);

    const c = await request(app(R4)).get('/nominas/informes/coste?ejercicio=2026&agrupar=empleado&formato=xlsx').buffer(true).parse(binario as never);
    expect(c.status).toBe(200);
    expect(await auditoria('EXPORTAR_COSTE_PERSONAL')).toHaveLength(1);
    // La consulta en pantalla (JSON) no es una exportacion.
    await request(app(R4)).get('/nominas/informes/coste?ejercicio=2026&agrupar=empleado');
    expect(await auditoria('EXPORTAR_COSTE_PERSONAL')).toHaveLength(1);
  });

  it('un PDF borrado (o sustituido por otro) ya no se descarga y sale del almacenamiento', async () => {
    const nomina = (await prisma.nomina.findFirstOrThrow({ where: { companyId: R4 } })).id;
    const pdf = (t: string) => ({ buffer: Buffer.from(`%PDF-1.4\n${t}\n%%EOF`), originalname: 'recibo.pdf', mimetype: 'application/pdf' });
    const primero = await subirDocumentoNominas(R4, 2026, 2, pdf('recibo equivocado'), { clase: 'nomina', nominaId: nomina });
    const rutaPrimero = (await prisma.documentoArchivo.findUniqueOrThrow({ where: { id: primero.id } })).archivoPath;
    const segundo = await subirDocumentoNominas(R4, 2026, 2, pdf('recibo bueno'), { clase: 'nomina', nominaId: nomina });
    await expect(descargarDocumentoNominas(R4, primero.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(fsp.access(path.join(process.cwd(), rutaPrimero))).rejects.toThrow();
    expect((await descargarDocumentoNominas(R4, segundo.id)).buffer.toString()).toContain('recibo bueno');

    await anularDocumentoNominas(R4, segundo.id);
    const d = await request(app(R4)).get(`/nominas/documentos/${segundo.id}/descargar`);
    expect(d.status).toBe(404);
  });

  it('atrasos: el ejercicio de devengo se guarda al importar y no se hereda al reimportar sin el', async () => {
    const fila = (extra: Record<string, unknown>) =>
      filasDesdeJson([{ nif: nif(84000001), nombre: 'Persona', apellidos: 'Auditada', ejercicio: 2026, mes: 3, tipo: 'ATRASOS', brutoDinerario: 400, irpf: 40, liquido: 360, ...extra }]);
    const r = await confirmarImportacion(R4, { filas: fila({ ejercicioDevengo: 2025 }) });
    const [id] = r.nominaIds;
    expect(await prisma.nomina.findUniqueOrThrow({ where: { id } })).toMatchObject({ tipo: 'ATRASOS', ejercicioDevengo: 2025 });
    const m = await calcularModelo190(R4, 2026);
    expect(m.perceptores.find((p) => p.ejercicioDevengo === 2025)).toMatchObject({ clave: 'A', percepcionIntegra: 400, retenciones: 40 });

    await confirmarImportacion(R4, { filas: fila({}) });
    expect((await prisma.nomina.findUniqueOrThrow({ where: { id } })).ejercicioDevengo).toBeNull();
    expect((await calcularModelo190(R4, 2026)).avisos.join(' ')).toMatch(/atrasos no indican el ejercicio de devengo/);
  });

  it('lector de gastos: el recibo de la SS se registra en una empresa sin trabajadores; con trabajadores, va a Nominas', async () => {
    const recibo = { tipoDocumento: 'seguros_sociales', numeroFactura: 'RLC-03', proveedor: 'TGSS', fecha: '2026-03-31', base: 320, iva: 0, total: 320, cuentaContableBase: '642000' };
    const sin = await request(app(R5)).post('/gastos-extractor/confirmar').send(recibo);
    expect(sin.status).toBe(200);
    const con = await request(app(R4)).post('/gastos-extractor/confirmar').send(recibo);
    expect(con.status).toBe(400);
    expect(con.body.message).toMatch(/Seguridad Social/);
    // Corregida la clasificacion en la pantalla ("Es una factura de gasto"), pero a la 642: tampoco.
    const cuenta = await request(app(R4)).post('/gastos-extractor/confirmar').send({ ...recibo, tipoDocumento: 'factura' });
    expect(cuenta.status).toBe(400);
    expect(cuenta.body.message).toMatch(/640, 641 y 642/);
  });
});
