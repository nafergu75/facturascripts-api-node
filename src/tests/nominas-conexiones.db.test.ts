/**
 * Nominas conectadas, sobre BD real: 111 por fecha de pago con perceptores
 * distintos (2 meses x 3 trabajadores -> casilla 01 = 3) en las tres puertas
 * (calculo, pantalla de modelos fiscales y TXT del modulo Impuestos), pago de
 * liquidos (465 contra 572, tambien conciliando un cargo del extracto), seguros
 * sociales con su RLC, pago del 111, modelo 190 por perceptor con su fichero,
 * PDF en el archivo privado, coste de personal y prevision de pagos.
 *
 * Necesita MySQL (en GitHub Actions lo levanta el workflow de tests). Los NIF
 * son inventados (numeros con su letra de control calculada).
 */
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { promises as fsp } from 'fs';
import * as path from 'path';
import { prisma } from '../config/database';
import { letraNif } from '../utils/nif';
import { anularNominas, borrarNomina, contabilizarNominas, crearNomina } from '../services/nominas.service';
import { crearEmpleado } from '../services/empleados.service';
import { calcularModelo111 } from '../services/impuestosCalculo.service';
import { autorrellenarModelo, generarTxtModelo } from '../services/impuestosModulo.service';
import { taxModelsService } from '../services/tax-models.service';
import { calcularModelo190, periodoFiscal, retencionesTrabajo } from '../services/nominas/fiscal';
import { generarFicheroModelo190 } from '../services/nominas/modelo190';
import { anularPagoModelo111, anularPagoNominas, pagarModelo111, pagarNominas, pagoModelo111 } from '../services/nominas/tesoreria';
import { anularPagoSegurosSociales, guardarSegurosSociales, listarSegurosSociales, obtenerSegurosSociales, pagarSegurosSociales } from '../services/nominas/segurosSociales';
import { anularDocumentoNominas, descargarDocumentoNominas, listarDocumentosNominas, subirDocumentoNominas, zipDocumentosNominas } from '../services/nominas/documentos';
import { informeCoste, previsionPagos, sugerenciasMovimiento } from '../services/nominas/informes';
import { listarDocumentosPorPeriodo, obtenerDocumento } from '../services/documentoArchivo.service';

const COMPANY_ID = `nomcon-test-${Date.now()}`;
const COMPANY_190 = `nom190-test-${Date.now()}`;
const nif = (n: number) => `${String(n).padStart(8, '0')}${letraNif(n)}`;

let banco: string;
const emp: Record<string, string> = {};
const nominas: Record<string, string> = {};

const T1 = periodoFiscal(2026, '1T');
const T2 = periodoFiscal(2026, '2T');
const asiento = (id: string) => prisma.journalEntry.findUniqueOrThrow({ where: { id }, include: { lineas: true } });
const porCuenta = (lineas: Array<{ accountCode: string; debe: number; haber: number }>) =>
  Object.fromEntries(lineas.map((l) => [l.accountCode, [Number(l.debe), Number(l.haber)]]));

// Importes de cada trabajador por mes (cuadran: bruto - SS - IRPF = liquido).
const IMPORTES: Record<string, { brutoDinerario: number; ssTrabajador: number; irpf: number; liquido: number; ssEmpresa: number }> = {
  A: { brutoDinerario: 2000, ssTrabajador: 127, irpf: 300, liquido: 1573, ssEmpresa: 600 },
  B: { brutoDinerario: 1800, ssTrabajador: 114.3, irpf: 180, liquido: 1505.7, ssEmpresa: 540 },
  C: { brutoDinerario: 1500, ssTrabajador: 95.25, irpf: 120, liquido: 1284.75, ssEmpresa: 450 },
};
const LIQUIDO_MES = 4363.45;
const SS_MES = 1926.55;

beforeAll(async () => {
  for (const id of [COMPANY_ID, COMPANY_190]) {
    await prisma.company.create({ data: { id, name: `Empresa ${id}`, fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
  }
  banco = (await prisma.bankAccount.create({ data: { companyId: COMPANY_ID, iban: 'ES0000000000000000000099', bancoNombre: 'Banco Prueba', subcuentaCodigo: '572001' } })).id;
  for (const [k, n] of [['A', 40000001], ['B', 40000002], ['C', 40000003], ['D', 40000004]] as const) {
    emp[k] = (await crearEmpleado(COMPANY_ID, { nif: nif(n), nombre: `Persona ${k}`, apellidos: 'Prueba', provincia: '46', anioNacimiento: 1990 })).id;
  }
  for (const mes of [1, 2]) {
    for (const k of ['A', 'B', 'C']) nominas[`${k}${mes}`] = (await crearNomina(COMPANY_ID, { empleadoId: emp[k], ejercicio: 2026, mes, ...IMPORTES[k] })).id;
  }
  // Diciembre de 2025 pagada el 5 de enero: va al 1T de 2026 (fecha de pago).
  nominas.A12 = (await crearNomina(COMPANY_ID, { empleadoId: emp.A, ejercicio: 2025, mes: 12, fechaPago: '2026-01-05', ...IMPORTES.A })).id;
  // Un profesional con retencion en febrero (casillas 07-09).
  const prov = await prisma.supplier.create({ data: { companyId: COMPANY_ID, nombreFiscal: 'Asesoria Prueba SL', nifCif: 'B46000001', cp: '46001' } });
  await prisma.expenseInvoice.create({
    data: {
      companyId: COMPANY_ID,
      supplierId: prov.id,
      serie: 'P',
      numero: 1,
      numeroCompleto: 'P-1',
      fechaEmision: '2026-02-10',
      fechaVencimiento: '2026-03-10',
      estado: 'CONFIRMED',
      tipoGasto: 'SERVICIO_PROFESIONAL',
      baseTotal: 1000,
      ivaTotal: 210,
      retencionTotal: 150,
      tipoRetencion: 15,
      totalFactura: 1060,
    },
  });
  await contabilizarNominas(COMPANY_ID, 2026, 1);
  await contabilizarNominas(COMPANY_ID, 2026, 2);
});

afterAll(async () => {
  // PDF de prueba guardados en el disco local (storage/ no se sube al repo).
  await fsp.rm(path.join(process.cwd(), 'storage', 'nominas', COMPANY_ID), { recursive: true, force: true });
});

describe('modelo 111: una sola fuente, por fecha de pago y con perceptores distintos', () => {
  it('2 meses y 3 trabajadores: casilla 01 = 3 (la nomina de diciembre pagada en enero tambien entra, del mismo trabajador)', async () => {
    const t = await retencionesTrabajo(COMPANY_ID, T1);
    expect(t.casillas).toEqual({
      perceptoresDinerarios: 3,
      percepcionesDinerarias: 2 * 5300 + 2000,
      retencionesDinerarias: 2 * 600 + 300,
      perceptoresEspecie: 0,
      percepcionesEspecie: 0,
      ingresosACuenta: 0,
    });
    expect(t).toMatchObject({ nominas: 7, borradores: 1 });
    expect(t.avisos[0]).toMatch(/siguen en borrador/);
  });

  it('calculo (Impuestos), pantalla de modelos fiscales y TXT dan lo mismo', async () => {
    const d = await calcularModelo111(COMPANY_ID, T1);
    expect(d).toMatchObject({
      nPerceptoresTrabajo: 3,
      percepcionesTrabajo: 12600,
      retencionesTrabajo: 1500,
      nPerceptoresActividades: 1,
      percepcionesActividades: 1000,
      retencionesActividades: 150,
      totalRetenciones: 1650,
      resultadoIngresar: 1650,
    });

    const pantalla = await taxModelsService.generarModelo111(COMPANY_ID, 2026, 1);
    expect(pantalla.casillas).toMatchObject({ '01': 3, '02': 12600, '03': 1500, '07': 1, '09': 150, '28': 1650 });
    expect(pantalla).toMatchObject({ totalRetenido: 1650, totalBase: 13600, estado: 'vigente' });
    // Lo guardado tiene el formato del modulo Impuestos: casillas oficiales y datos del TXT.
    const fila = await prisma.modeloImpuesto.findUniqueOrThrow({ where: { id: pantalla.id } });
    expect(fila.casillas).toMatchObject({ '01_perceptores_trabajo': 3, '28_total_retenciones': 1650 });
    expect(fila.datos).toMatchObject({ nPerceptoresTrabajo: 3, totalRetenciones: 1650 });

    const txt = await generarTxtModelo(COMPANY_ID, pantalla.id);
    const pagina = txt.contenido.slice(328, 328 + 1000);
    expect(pagina.slice(108, 116)).toBe('00000003'); // [01] pos 109
    expect(pagina.slice(116, 133)).toBe('00000000001260000'); // [02]
    expect(pagina.slice(192, 200)).toBe('00000001'); // [07] pos 193
    expect(pagina.slice(486, 503)).toBe('00000000000165000'); // [28] pos 487
  });
});

describe('pago de los liquidos', () => {
  it('465 de cada trabajador contra 572; las nominas quedan PAGADAS con la fecha del pago', async () => {
    const r = await pagarNominas(COMPANY_ID, 2026, 1, { fecha: '2026-01-30', cuentaBancariaId: banco });
    expect(r).toMatchObject({ pagadas: 3, importe: LIQUIDO_MES, fecha: '2026-01-30', cuentaTesoreria: '572001', movimientoId: null });
    expect(r.asiento.numero).toMatch(/^NOM-PAG-\d{5}$/);
    const a = await asiento(r.asiento.id);
    expect(a).toMatchObject({ estado: 'POSTED', origen: 'NOMINA_PAGO', invoiceType: 'NOMINA_PAGO' });
    const ns = await prisma.nomina.findMany({ where: { id: { in: ['A1', 'B1', 'C1'].map((k) => nominas[k]) } }, include: { empleado: true } });
    const lineas = porCuenta(a.lineas);
    expect(lineas['572001']).toEqual([0, LIQUIDO_MES]);
    for (const n of ns) {
      expect(n).toMatchObject({ estado: 'PAGADA', fechaPago: '2026-01-30', asientoPagoId: r.asiento.id, cuentaPago: '572001' });
      expect(lineas[n.empleado.subcuenta465!]).toEqual([Number(n.liquido), 0]);
    }
  });

  it('no se paga dos veces, ni se anula o borra una nomina pagada sin anular antes el pago', async () => {
    await expect(pagarNominas(COMPANY_ID, 2026, 1, { cuentaBancariaId: banco })).rejects.toMatchObject({ statusCode: 409 });
    await expect(anularNominas(COMPANY_ID, 2026, 1)).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/anula antes el pago/) });
    await expect(borrarNomina(COMPANY_ID, nominas.A1)).rejects.toMatchObject({ statusCode: 409 });
  });

  let cargo: string;

  it('conciliando un cargo del extracto: la sugerencia "Pago nóminas 02/2026", el importe tiene que cuadrar y el movimiento queda conciliado', async () => {
    const otro = await prisma.bankMovement.create({ data: { companyId: COMPANY_ID, cuentaBancariaId: banco, fecha: '2026-02-26', importe: -100, concepto: 'RECIBO', origen: 'csv' } });
    cargo = (await prisma.bankMovement.create({ data: { companyId: COMPANY_ID, cuentaBancariaId: banco, fecha: '2026-02-27', importe: -LIQUIDO_MES, concepto: 'TRANSF NOMINAS FEB', origen: 'csv' } })).id;
    const s = await sugerenciasMovimiento(COMPANY_ID, cargo);
    expect(s.sugerencias).toEqual([expect.objectContaining({ tipo: 'liquidos', ejercicio: 2026, mes: 2, importe: LIQUIDO_MES, concepto: 'Pago nóminas 02/2026' })]);
    await expect(pagarNominas(COMPANY_ID, 2026, 2, { movimientoId: otro.id })).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/no coincide/) });

    const r = await pagarNominas(COMPANY_ID, 2026, 2, { movimientoId: cargo });
    expect(r).toMatchObject({ pagadas: 3, fecha: '2026-02-27', cuentaTesoreria: '572001', movimientoId: cargo });
    expect(await prisma.bankMovement.findUniqueOrThrow({ where: { id: cargo } })).toMatchObject({ conciliado: true, referencia: `nominas-pago:${r.asiento.id}` });
    await expect(pagarNominas(COMPANY_ID, 2026, 1, { movimientoId: cargo })).rejects.toMatchObject({ statusCode: 409 });
  });

  it('anular el pago: asiento REVERSED, movimiento sin conciliar y nominas otra vez CONTABILIZADAS', async () => {
    const n = await prisma.nomina.findUniqueOrThrow({ where: { id: nominas.A2 } });
    const r = await anularPagoNominas(COMPANY_ID, 2026, 2, { nominaIds: [nominas.A2] });
    // Un pago se anula entero: van tambien las otras dos nominas del mismo pago.
    expect(r).toMatchObject({ nominas: 3, arrastradas: 2, contraasientos: [], movimientosDesconciliados: 1 });
    expect(r.asientosRevertidos).toHaveLength(1);
    expect((await asiento(n.asientoPagoId!)).estado).toBe('REVERSED');
    expect(await prisma.bankMovement.findUniqueOrThrow({ where: { id: cargo } })).toMatchObject({ conciliado: false, referencia: null });
    for (const k of ['A2', 'B2', 'C2']) {
      expect(await prisma.nomina.findUniqueOrThrow({ where: { id: nominas[k] } })).toMatchObject({ estado: 'CONTABILIZADA', asientoPagoId: null, cuentaPago: null });
    }
    await expect(anularPagoNominas(COMPANY_ID, 2026, 2)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('nomina de marzo pagada el 2 de abril: su IRPF va al 111 del 2T; una anulada no cuenta', async () => {
    nominas.D3 = (await crearNomina(COMPANY_ID, { empleadoId: emp.D, ejercicio: 2026, mes: 3, brutoDinerario: 1000, ssTrabajador: 63.5, irpf: 100, liquido: 836.5, ssEmpresa: 300 })).id;
    const extra = await crearNomina(COMPANY_ID, { empleadoId: emp.C, ejercicio: 2026, mes: 3, tipo: 'EXTRA', fechaPago: '2026-03-20', brutoDinerario: 900, irpf: 90, liquido: 810 });
    await anularNominas(COMPANY_ID, 2026, 3, { nominaIds: [extra.id], dejarAnuladas: true });
    await contabilizarNominas(COMPANY_ID, 2026, 3);
    const r = await pagarNominas(COMPANY_ID, 2026, 3, { fecha: '2026-04-02', cuentaBancariaId: banco });
    expect(r.avisos.join(' ')).toMatch(/Se paga en el 2T\/2026/);
    expect((await retencionesTrabajo(COMPANY_ID, T1)).casillas).toMatchObject({ perceptoresDinerarios: 3, retencionesDinerarias: 1500 });
    expect((await retencionesTrabajo(COMPANY_ID, T2)).casillas).toMatchObject({ perceptoresDinerarios: 1, percepcionesDinerarias: 1000, retencionesDinerarias: 100 });
  });
});

describe('seguros sociales', () => {
  it('lo previsto por las nominas; el RLC con 10 € mas lleva la diferencia a la 642', async () => {
    const ss = await obtenerSegurosSociales(COMPANY_ID, 2026, 1);
    expect(ss).toMatchObject({ nominas: 3, cuotaObrera: 336.55, cuotaPatronal: 1590, totalPrevisto: SS_MES, aPagar: SS_MES, diferencia: 0, estado: 'PENDIENTE', fechaCargoPrevista: '2026-02-28' });
    expect(await guardarSegurosSociales(COMPANY_ID, 2026, 1, { totalRlc: SS_MES + 10 })).toMatchObject({ aPagar: 1936.55, diferencia: 10 });

    const r = await pagarSegurosSociales(COMPANY_ID, 2026, 1, { fecha: '2026-02-27', cuentaBancariaId: banco });
    expect(r).toMatchObject({ importe: 1936.55, totalPrevisto: SS_MES, diferencia: 10 });
    expect(r.asiento.numero).toMatch(/^SS-\d{5}$/);
    const a = await asiento(r.asiento.id);
    expect(a).toMatchObject({ origen: 'SEG_SOCIAL', invoiceType: 'SEG_SOCIAL', estado: 'POSTED' });
    expect(porCuenta(a.lineas)).toEqual({ '476000': [SS_MES, 0], '642000': [10, 0], '572001': [0, 1936.55] });
    expect(await obtenerSegurosSociales(COMPANY_ID, 2026, 1)).toMatchObject({ estado: 'PAGADA', fechaPago: '2026-02-27', asientoPagoNumero: r.asiento.numero });
    await expect(pagarSegurosSociales(COMPANY_ID, 2026, 1, { cuentaBancariaId: banco })).rejects.toMatchObject({ statusCode: 409 });
    await expect(guardarSegurosSociales(COMPANY_ID, 2026, 1, { totalRlc: 1 })).rejects.toMatchObject({ statusCode: 409 });

    const anulado = await anularPagoSegurosSociales(COMPANY_ID, 2026, 1);
    expect(anulado.asientoRevertido).toBe(r.asiento.numero);
    expect((await obtenerSegurosSociales(COMPANY_ID, 2026, 1)).estado).toBe('PENDIENTE');
  });

  it('la IT compensada va a la 471; un mes sin nominas no se paga', async () => {
    const r = await pagarSegurosSociales(COMPANY_ID, 2026, 2, { fecha: '2026-03-31', cuentaBancariaId: banco, compensacionIt: 50, totalRlc: SS_MES - 50 });
    expect(porCuenta((await asiento(r.asiento.id)).lineas)).toEqual({ '476000': [SS_MES, 0], '471000': [0, 50], '572001': [0, 1876.55] });
    expect(await prisma.chartOfAccounts.findFirst({ where: { companyId: COMPANY_ID, codigo: '471000' } })).not.toBeNull();
    await expect(pagarSegurosSociales(COMPANY_ID, 2026, 6, { cuentaBancariaId: banco })).rejects.toMatchObject({ statusCode: 409 });
    const ano = await listarSegurosSociales(COMPANY_ID, 2026);
    expect(ano).toHaveLength(12);
    expect(ano.map((m) => m.estado).slice(0, 4)).toEqual(['PENDIENTE', 'PAGADA', 'PENDIENTE', 'SIN_NOMINAS']);
  });
});

describe('pago del 111', () => {
  it('4751 de trabajo y de profesionales contra 572; no se paga dos veces; se anula', async () => {
    // La nomina de diciembre pagada en enero sigue en borrador: su IRPF no esta en la 4751.
    await expect(pagarModelo111(COMPANY_ID, 2026, '1T', { fecha: '2026-04-15', cuentaBancariaId: banco })).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringMatching(/en borrador/),
    });
    await contabilizarNominas(COMPANY_ID, 2025, 12);
    const r = await pagarModelo111(COMPANY_ID, 2026, '1T', { fecha: '2026-04-15', cuentaBancariaId: banco });
    expect(r).toMatchObject({ importe: 1650, trabajo: 1500, profesionales: 150, cuentaProfesionales: '475100' });
    const a = await asiento(r.asiento.id);
    expect(a).toMatchObject({ origen: 'TESORERIA', invoiceType: 'MODELO_111', invoiceId: '2026-1T' });
    expect(porCuenta(a.lineas)).toEqual({ '475101': [1500, 0], '475100': [150, 0], '572001': [0, 1650] });
    await expect(pagarModelo111(COMPANY_ID, 2026, '1T', { cuentaBancariaId: banco })).rejects.toMatchObject({ statusCode: 409 });
    expect((await previsionPagos(COMPANY_ID, '2026-04-01', '2026-04-30')).pagos.some((p) => p.tipo === 'modelo111')).toBe(false);

    await anularPagoModelo111(COMPANY_ID, 2026, '1T');
    expect(await pagoModelo111(COMPANY_ID, 2026, '1T')).toBeNull();
    expect((await asiento(r.asiento.id)).estado).toBe('REVERSED');
  });
});

describe('PDF de las nominas en el archivo privado', () => {
  const pdf = (texto: string) => ({ buffer: Buffer.from(`%PDF-1.4\n${texto}\n%%EOF`), originalname: 'nómina enero.pdf', mimetype: 'application/pdf' });

  it('se sube, se lista y se descarga por nominas; un PDF repetido da 409', async () => {
    const d = await subirDocumentoNominas(COMPANY_ID, 2026, 1, pdf('recibo A enero'), { clase: 'nomina', nominaId: nominas.A1, userId: 'u1' });
    expect(d).toMatchObject({ tipo: 'nomina', clase: 'nomina', ejercicio: 2026, mes: 1, nominaId: nominas.A1, trabajador: 'Persona A Prueba' });
    await expect(subirDocumentoNominas(COMPANY_ID, 2026, 1, pdf('recibo A enero'), { clase: 'nomina' })).rejects.toMatchObject({ statusCode: 409 });
    await expect(subirDocumentoNominas(COMPANY_ID, 2026, 2, pdf('otro'), { clase: 'nomina', nominaId: nominas.A1 })).rejects.toMatchObject({ statusCode: 400 });
    const rlc = await subirDocumentoNominas(COMPANY_ID, 2026, 1, pdf('RLC enero'), { clase: 'rlc' });
    expect(rlc).toMatchObject({ tipo: 'seguros_sociales', clase: 'rlc' });

    expect((await listarDocumentosNominas(COMPANY_ID, { ejercicio: 2026, mes: 1 })).map((x) => x.clase)).toEqual(['nomina', 'rlc']);
    expect((await descargarDocumentoNominas(COMPANY_ID, d.id)).buffer.toString()).toContain('recibo A enero');
    expect((await zipDocumentosNominas(COMPANY_ID, { ejercicio: 2026, trimestre: 1 })).contenido.subarray(0, 2).toString()).toBe('PK');

    // El archivo general de facturas (contabilidad:read) no los ve.
    expect((await listarDocumentosPorPeriodo(COMPANY_ID, { anio: 2026 })).total).toBe(0);
    await expect(obtenerDocumento(COMPANY_ID, d.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(listarDocumentosPorPeriodo(COMPANY_ID, { anio: 2026, tipo: 'nomina' as never })).rejects.toMatchObject({ statusCode: 400 });

    await anularDocumentoNominas(COMPANY_ID, rlc.id);
    expect(await listarDocumentosNominas(COMPANY_ID, { ejercicio: 2026 })).toHaveLength(1);
  });
});

describe('coste de personal y prevision de pagos', () => {
  it('coste por mes y por trabajador (sin las anuladas)', async () => {
    const porMes = await informeCoste(COMPANY_ID, 2026, 'mes');
    expect(porMes.filas).toHaveLength(12);
    expect(porMes.filas[0]).toMatchObject({ mes: 1, nominas: 3, trabajadores: 3, bruto: 5300, ssEmpresa: 1590, costeEmpresa: 6890, liquido: LIQUIDO_MES });
    expect(porMes.filas[2]).toMatchObject({ nominas: 1, bruto: 1000, costeEmpresa: 1300 });
    expect(porMes.totales).toMatchObject({ nominas: 7, trabajadores: 4, costeEmpresa: 2 * 6890 + 1300 });

    const porTrabajador = await informeCoste(COMPANY_ID, 2026, 'empleado');
    expect(porTrabajador.filas.find((f) => f.empleadoId === emp.A)).toMatchObject({ nominas: 2, bruto: 4000, costeEmpresa: 5200 });
  });

  it('prevision: liquidos sin pagar, seguros sociales pendientes y el 111 que vence en el rango', async () => {
    const p = await previsionPagos(COMPANY_ID, '2026-01-01', '2026-04-30');
    expect(p.pagos).toEqual(
      expect.arrayContaining([
        // Su pago se anulo: la fecha de pago vuelve a la de antes del pago (la de devengo), no la del pago anulado.
        expect.objectContaining({ tipo: 'liquidos', ejercicio: 2026, mes: 2, importe: LIQUIDO_MES, fecha: '2026-02-28', categoria: 'Nóminas' }),
        expect.objectContaining({ tipo: 'seguros_sociales', mes: 1, importe: 1936.55, fecha: '2026-02-28' }),
        expect.objectContaining({ tipo: 'seguros_sociales', mes: 3, importe: 363.5, fecha: '2026-04-30' }),
        expect.objectContaining({ tipo: 'modelo111', periodo: '1T', importe: 1650, fecha: '2026-04-20' }),
      ]),
    );
    // Pagados: liquidos de enero y marzo, y la SS de febrero.
    expect(p.pagos.some((x) => x.tipo === 'liquidos' && (x.mes === 1 || x.mes === 3))).toBe(false);
    expect(p.pagos.some((x) => x.tipo === 'seguros_sociales' && x.mes === 2)).toBe(false);
  });
});

describe('modelo 190 por perceptor (ejercicio 2025, diseno de registro verificado)', () => {
  it('registros A, L.01 y G con sus totales, cuadre con los cuatro 111 y fichero de 500 posiciones', async () => {
    const e1 = await crearEmpleado(COMPANY_190, { nif: nif(50000001), nombre: 'Ana', apellidos: 'Prueba Uno', provincia: '28', anioNacimiento: 1980, situacionFamiliar: 3 });
    const e2 = await crearEmpleado(COMPANY_190, { nif: nif(50000002), nombre: 'Blas', apellidos: 'Prueba Dos', provincia: '46', anioNacimiento: 1995, tipoContrato: 'TEMPORAL' });
    await crearNomina(COMPANY_190, { empleadoId: e1.id, ejercicio: 2025, mes: 1, brutoDinerario: 2000, dietasExentas: 50, ssTrabajador: 127, irpf: 300, liquido: 1623, ssEmpresa: 600 });
    await crearNomina(COMPANY_190, { empleadoId: e1.id, ejercicio: 2025, mes: 7, brutoDinerario: 2000, ssTrabajador: 127, irpf: 300, liquido: 1573, ssEmpresa: 600 });
    // Especie 100 con ingreso a cuenta de 20 que asume la empresa: el liquido no cambia.
    await crearNomina(COMPANY_190, { empleadoId: e2.id, ejercicio: 2025, mes: 7, brutoDinerario: 1500, especieValoracion: 100, ingresoACuenta: 20, ssTrabajador: 95.25, irpf: 150, liquido: 1254.75, ssEmpresa: 450 });
    for (const mes of [1, 7]) await contabilizarNominas(COMPANY_190, 2025, mes);
    const prov = await prisma.supplier.create({ data: { companyId: COMPANY_190, nombreFiscal: 'Abogada Prueba', nifCif: nif(50000009), cp: '03001' } });
    await prisma.expenseInvoice.create({
      data: { companyId: COMPANY_190, supplierId: prov.id, serie: 'P', numero: 1, numeroCompleto: 'P-1', fechaEmision: '2025-05-05', fechaVencimiento: '2025-06-05', estado: 'ACCOUNTED', baseTotal: 600, retencionTotal: 90, tipoRetencion: 15, totalFactura: 636 },
    });

    const m = await calcularModelo190(COMPANY_190, 2025);
    expect(m.perceptores.map((p) => `${p.clave}${p.subclave ?? ''} ${p.nif}`)).toEqual([`A ${nif(50000002)}`, `A ${nif(50000001)}`, `G01 ${nif(50000009)}`, `L01 ${nif(50000001)}`]);
    expect(m.perceptores.find((p) => p.clave === 'A' && p.nif === nif(50000001))).toMatchObject({ percepcionIntegra: 4000, retenciones: 600, gastosDeducibles: 254, documentos: 2, anioNacimiento: 1980, provincia: '28' });
    expect(m.perceptores.find((p) => p.clave === 'A' && p.nif === nif(50000002))).toMatchObject({ percepcionIntegra: 1500, valoracionEspecie: 100, ingresosACuentaEfectuados: 20, ingresosACuentaRepercutidos: 0, contrato: 2 });
    expect(m.totales).toEqual({ registros: 4, perceptores: 3, percepciones: 4000 + 1600 + 600 + 50, retenciones: 600 + 150 + 20 + 90 });
    expect(m.cuadre111).toMatchObject({ total: 860, coincide: true });
    expect(m.avisos).toEqual([]);

    const f = generarFicheroModelo190(2025, { nif: 'B98765432', nombre: 'Empresa 190 SL', telefono: '600000000', contacto: 'Contacto' }, m.perceptores);
    const regs = f.replace(/\r\n$/, '').split('\r\n');
    expect(regs).toHaveLength(5);
    for (const r of regs) expect(r).toHaveLength(500);
    expect(regs[0].slice(135, 144)).toBe('000000004');
    expect(regs[0].slice(160, 175)).toBe('000000000086000');

    // La pantalla de modelos fiscales y el modulo Impuestos guardan lo mismo, y solo totales (sin datos personales).
    const pantalla = await taxModelsService.generarModelo190(COMPANY_190, 2025);
    expect(pantalla).toMatchObject({ totalRetenido: 860, totalBase: 6250, cuadre111: { coincide: true }, casillas: { '01': 4 } });
    const modulo = await autorrellenarModelo(COMPANY_190, pantalla.id);
    expect(modulo.casillas).toMatchObject({ num_percepciones: 4, importe_percepciones: 6250, retenciones_ingresos_cuenta: 860, cuadra_con_111: 'si' });
    expect(modulo.resumen.fechaVencimiento).toBe('2026-01-31');
    const fila = await prisma.modeloImpuesto.findUniqueOrThrow({ where: { id: pantalla.id } });
    expect(JSON.stringify(fila)).not.toContain(nif(50000001));
    expect(JSON.stringify(fila)).not.toContain('Prueba Uno');
    // El fichero (con los datos de cada trabajador) no se descarga desde Impuestos.
    await expect(generarTxtModelo(COMPANY_190, pantalla.id)).rejects.toMatchObject({ statusCode: 400 });
    // El 2026 aun no tiene diseno de registro verificado.
    await expect(Promise.resolve().then(() => generarFicheroModelo190(2026, { nif: 'B98765432', nombre: 'X' }, m.perceptores))).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('empresa no establecida en Espana: Nominas no le pide el 111 (como Impuestos)', () => {
  const COMPANY_US = `nomus-test-${Date.now()}`;
  let bancoUs: string;

  beforeAll(async () => {
    await prisma.company.create({ data: { id: COMPANY_US, name: `Empresa ${COMPANY_US}`, fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
    await prisma.legalConfig.create({ data: { companyId: COMPANY_US, denominacion: 'US Test Inc.', nif: '98-7654321', pais: 'US', monedaCuenta: 'USD' } });
    bancoUs = (await prisma.bankAccount.create({ data: { companyId: COMPANY_US, iban: 'US0000000000000000000099', bancoNombre: 'Bank', subcuentaCodigo: '572001', moneda: 'USD' } })).id;
    // Un gasto con retencion: con el 111 sin bloquear saldria un pago de 150 en la prevision.
    const prov = await prisma.supplier.create({ data: { companyId: COMPANY_US, nombreFiscal: 'Asesoria Prueba SL', nifCif: 'B46000001', cp: '46001' } });
    await prisma.expenseInvoice.create({
      data: {
        companyId: COMPANY_US,
        supplierId: prov.id,
        serie: 'P',
        numero: 1,
        numeroCompleto: 'P-1',
        fechaEmision: '2026-02-10',
        fechaVencimiento: '2026-03-10',
        estado: 'CONFIRMED',
        tipoGasto: 'SERVICIO_PROFESIONAL',
        baseTotal: 1000,
        ivaTotal: 0,
        retencionTotal: 150,
        tipoRetencion: 15,
        totalFactura: 850,
      },
    });
  });

  it('el pago del 111 da 400 y no crea asiento', async () => {
    await expect(pagarModelo111(COMPANY_US, 2026, '1T', { cuentaBancariaId: bancoUs, fecha: '2026-04-20' })).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringMatching(/no está establecida en España/),
    });
    expect(await prisma.journalEntry.count({ where: { companyId: COMPANY_US } })).toBe(0);
  });

  it('la prevision de pagos y las sugerencias del extracto no llevan el 111', async () => {
    const p = await previsionPagos(COMPANY_US, '2026-04-01', '2026-04-30');
    expect(p.pagos.filter((x) => x.tipo === 'modelo111')).toEqual([]);
    const mov = await prisma.bankMovement.create({ data: { companyId: COMPANY_US, cuentaBancariaId: bancoUs, fecha: '2026-04-20', importe: -150, concepto: 'AEAT 111', origen: 'csv' } });
    expect((await sugerenciasMovimiento(COMPANY_US, mov.id)).sugerencias).toEqual([]);
  });
});

describe('ZIP de los PDF de nominas', () => {
  it('por encima de 4 MB da 400 antes de leer los ficheros (Vercel no devuelve respuestas tan grandes)', async () => {
    const COMPANY_ZIP = `nomzip-test-${Date.now()}`;
    await prisma.company.create({ data: { id: COMPANY_ZIP, name: `Empresa ${COMPANY_ZIP}`, fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
    for (const n of [1, 2]) {
      await prisma.documentoArchivo.create({
        data: {
          companyId: COMPANY_ZIP,
          tipo: 'seguros_sociales',
          fecha: '2026-03-31',
          mes: 3,
          trimestre: 1,
          anio: 2026,
          archivoNombre: `rlc${n}.pdf`,
          archivoTipo: 'application/pdf',
          archivoTamanio: 3 * 1024 * 1024,
          archivoPath: `nominas/${COMPANY_ZIP}/no-existe-${n}.pdf`,
          archivoHash: `hash-${COMPANY_ZIP}-${n}`,
          observaciones: 'RLC',
        },
      });
    }
    await expect(zipDocumentosNominas(COMPANY_ZIP, { ejercicio: 2026, mes: 3 })).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringMatching(/descárgalos por mes o uno a uno/),
    });
  });
});
