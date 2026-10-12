/**
 * Los modelos de Hacienda dan lo mismo con subcuentas por tercero (430N, 400N,
 * 410N) que con las cuentas genericas (430, 400, 410).
 *
 * Se siembra un año de 2027 con lo que pasa por las subcuentas:
 *  - ventas emitidas y contabilizadas, una de ellas cobrada en parte, y una
 *    rectificativa que la anula;
 *  - una venta registrada con el lector, con su asiento aprobado y cobrada;
 *  - una entrega intracomunitaria;
 *  - compras a un mismo proveedor por la 400N (mercaderías) y la 410N
 *    (suministros), una de ellas pagada;
 *  - una compra leída con el lector con una parte exenta;
 *  - alquileres con retención (115 y 180) y un profesional con retención (111
 *    y 190);
 *  - una compra intracomunitaria.
 *
 * Se calcula lo que se presentaría de cada modelo (303, 390, 347, 349, 111,
 * 115, 180 y 190), se pasan todos los apuntes de las subcuentas a la cuenta
 * generica (y se quitan las subcuentas de las fichas y del plan) y se vuelve a
 * calcular: tiene que salir exactamente lo mismo. El 347 va por tercero (NIF):
 * el proveedor con 400N y 410N es un solo declarado.
 *
 * Necesita MySQL (en GitHub Actions lo levanta el workflow de tests).
 */
import { describe, it, expect, beforeAll, jest } from '@jest/globals';
import { prisma } from '../config/database';
import { clientesService } from '../services/clientes.service';
import { proveedoresService } from '../services/proveedores.service';
import { incomeInvoicesService } from '../services/income-invoices.service';
import { registrarGasto } from '../services/expense-invoices.service';
import { contabilizarVentaLeida } from '../services/ingresos-extractor.service';
import { AccountingEngineController } from '../controllers/accounting-engine.controller';
import { registrarCobroFactura } from '../services/cobrosPagos.service';
import { asegurarPlanContableEmpresa } from '../services/chart-of-accounts.service';
import { crearInmueble } from '../services/borradoresAeat/inmuebles.service';
import { presentable } from '../services/declaracionesAeat/modelos';
import type { CodigoAeat } from '../services/declaracionesAeat/declaraciones.service';
import { obtenerIvaDevengadoDesdeAsientos, obtenerIvaSoportadoDesdeAsientos } from '../services/impuestosCalculo.service';
import { esSubcuentaDeTercero } from '../services/terceros/numeracion';
import { controlCif, letraDni } from '../utils/nif';

const SUFIJO = Date.now();
const E = `modelos-subc-${SUFIJO}`;
const motor = new AccountingEngineController();
let n = 0;

/** CIF valido distinto en cada llamada. */
function cif(): string {
  const siete = String(1000000 + ((SUFIJO + n++ * 7919) % 8999999)).slice(0, 7);
  return `B${siete}${controlCif(siete).cifra}`;
}
function dni(): string {
  const ocho = String(10000000 + ((SUFIJO + n++ * 104729) % 89999999)).slice(0, 8);
  return `${ocho}${letraDni(ocho)}`;
}

const linea = (precio: number, tipoIva = 21, tipoRetencion = 0) => ({ descripcion: 'Concepto', cantidad: 1, precioUnitario: precio, tipoIva, tipoRetencion });

/** Emite una venta (borrador y emision en su fecha) y la contabiliza. */
async function venta(customerId: string, fecha: string, lineas: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}): Promise<string> {
  const b = await incomeInvoicesService.crearIngreso({ companyId: E, customer: { id: customerId }, fechaEmision: fecha, lineas, borrador: true, ...extra } as never);
  const f = await incomeInvoicesService.finalizar(E, b.id, { fechaEmision: fecha });
  await motor.contabilizarFacturaIngreso(E, f.id);
  return f.id;
}

async function gasto(cuerpo: Record<string, unknown>, contabilizar: 'POSTED' | 'DRAFT' = 'POSTED') {
  return registrarGasto(E, { numeroFacturaProveedor: `F-${n++}`, ...cuerpo }, { contabilizar });
}

const PERIODOS: Array<[CodigoAeat, string[]]> = [
  ['303', ['1T', '2T', '3T']],
  ['111', ['1T', '2T', '3T']],
  ['115', ['1T', '2T', '3T']],
  ['349', ['1T', '2T', '3T']],
  ['390', ['0A']],
  ['347', ['0A']],
  ['180', ['0A']],
  ['190', ['0A']],
];

/** Lo que se presentaria de cada modelo: casillas, registros, errores y fichero. */
async function todosLosModelos() {
  const out: Record<string, unknown> = {};
  for (const [codigo, periodos] of PERIODOS) {
    for (const periodo of periodos) {
      const p = await presentable(E, codigo, 2027, periodo);
      out[`${codigo} ${periodo}`] = {
        errores: p.errores,
        casillas: p.instantanea.casillas,
        registros: p.instantanea.registros ?? null,
        fichero: p.instantanea.fichero ?? null,
      };
    }
  }
  out['477 por prefijo'] = await obtenerIvaDevengadoDesdeAsientos(E, 2027);
  out['472 por prefijo'] = await obtenerIvaSoportadoDesdeAsientos(E, 2027);
  return out;
}

let conSubcuentas: Record<string, unknown>;

beforeAll(async () => {
  await prisma.company.create({ data: { id: E, name: 'Cuadre Subcuentas SL', fsBaseUrl: 'http://localhost', fsApiKeyEnc: 'k' } });
  await prisma.legalConfig.create({
    data: { companyId: E, denominacion: 'Cuadre Subcuentas, S.L.', nif: cif(), telefono: '963 11 22 33', personaContacto: 'Gómez Ruiz Ana', cnae: '4690' },
  });
  await asegurarPlanContableEmpresa(E);

  // Las facturas de 2027 no se pueden emitir antes de su fecha (Verifactu, P3):
  // solo mientras se crean, hoy es el 20-10-2027. Solo se finge la fecha.
  jest.useFakeTimers({
    now: new Date('2027-10-20T10:00:00Z'),
    doNotFake: ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'],
  });
  try {
    await sembrar();
  } finally {
    jest.useRealTimers();
  }
  conSubcuentas = await todosLosModelos();
});

async function sembrar() {
  const id = (x: unknown) => String((x as { id: string }).id);
  const ferreteria = id(await clientesService.create(E, { nombreFiscal: 'Ferretería López SL', nifCif: cif(), cp: '46001' }));
  const aleman = id(await clientesService.create(E, { nombreFiscal: 'Müller Handels GmbH', nifCif: 'DE123456789', pais: 'DE' }));
  const mayorista = (await proveedoresService.create(E, { nombreFiscal: 'Mayorista Turia SL', nifCif: cif(), cp: '46002' })).id;
  const lector = (await proveedoresService.create(E, { nombreFiscal: 'Papelería Lectora SL', nifCif: cif(), cp: '46003' })).id;
  const casero = (await proveedoresService.create(E, { nombreFiscal: 'Martínez Peña José', nifCif: dni(), cp: '46004', provincia: 'Valencia' })).id;
  const asesor = (await proveedoresService.create(E, { nombreFiscal: 'Sanz Vidal Marta', nifCif: dni(), cp: '46005', provincia: 'Valencia' })).id;
  const italiano = (await proveedoresService.create(E, { nombreFiscal: 'Rossi SpA', nifCif: 'IT12345678901', pais: 'IT' })).id;
  await crearInmueble(E, {
    supplierId: casero,
    referenciaCatastral: '9872023VH5797S0001WX',
    tipoVia: 'CL',
    nombreVia: 'Colón',
    numeroCasa: '12',
    municipio: 'València',
    codigoMunicipio: '46250',
    codigoPostal: '46004',
  });

  // Compras: el mismo proveedor por la 400N (mercaderias) y la 410N (suministros).
  const compra = await gasto({ proveedor: { id: mayorista }, fechaEmision: '2027-01-20', tipoGasto: 'COMPRA', lineas: [linea(4000)] });
  await registrarCobroFactura(E, 'GASTO', compra.factura.id, { fecha: '2027-02-20', importe: 2000, caja: true });
  await gasto({ proveedor: { id: mayorista }, fechaEmision: '2027-03-05', tipoGasto: 'SUMINISTROS', lineas: [linea(500)] });
  // Alquileres trimestrales con retencion del 19 % (115 y 180).
  for (const fecha of ['2027-01-05', '2027-04-05', '2027-07-05']) {
    await gasto({ proveedor: { id: casero }, fechaEmision: fecha, tipoGasto: 'ALQUILER', lineas: [linea(1500, 21, 19)] });
  }

  // Ventas: una cobrada en parte y otra anulada con una rectificativa.
  const v1 = await venta(ferreteria, '2027-02-10', [linea(3000)]);
  await registrarCobroFactura(E, 'INGRESO', v1, { fecha: '2027-03-01', importe: 1000, caja: true });

  // Venta leida con el lector: cliente nuevo, asiento en borrador que se aprueba, y cobrada.
  const leida = await incomeInvoicesService.crearIngreso(
    {
      companyId: E,
      customer: { nuevo: { nombreFiscal: 'Bar Lector SL', nifCif: cif(), cp: '46006' } },
      serie: 'LEC',
      numero: 15,
      fechaEmision: '2027-04-20',
      fechaVencimiento: '2027-05-20',
      lineas: [{ descripcion: 'Servicio', cantidad: 1, precioUnitario: 4000, tipoIva: 21 }],
    } as never,
    { origen: 'lector', numeroLeido: 'LEC-0015' },
  );
  const asientoLeida = await contabilizarVentaLeida(E, leida.id);
  expect(asientoLeida.contabilizada).toBe(true);
  // Con el documento del lector enlazado queda en borrador; aqui no hay documento.
  if (asientoLeida.asientoEnBorrador) await motor.aprobarAsiento(E, asientoLeida.asientoId!, 'u-cuadre');
  await registrarCobroFactura(E, 'INGRESO', leida.id, { fecha: '2027-05-02', caja: true });

  // Compra leida con el lector, con una parte exenta: asiento en borrador que se aprueba.
  const papel = await gasto({ proveedor: { id: lector }, fechaEmision: '2027-04-12', tipoGasto: 'COMPRA', lineas: [linea(3000), linea(300, 0)] }, 'DRAFT');
  await motor.aprobarAsiento(E, papel.asientoId, 'u-cuadre');

  const v2 = await venta(ferreteria, '2027-05-10', [linea(2000)]);
  // Profesional con retencion del 15 % (111 y 190).
  await gasto({ proveedor: { id: asesor }, fechaEmision: '2027-05-20', tipoGasto: 'SERVICIO_PROFESIONAL', lineas: [linea(2000, 21, 15)] });
  // Entrega intracomunitaria (349, clave E) y compra intracomunitaria.
  await venta(aleman, '2027-06-15', [linea(5000, 0)], { tipoOperacion: 'INTRACOMUNITARIA' });
  await gasto({ proveedor: { id: italiano }, fechaEmision: '2027-07-10', tipoGasto: 'COMPRA', lineas: [linea(2500, 0)] });

  // Rectificativa que anula la venta de mayo, en el 3T.
  const r = await incomeInvoicesService.crearRectificativa(E, v2, { motivo: 'Devolución', borrador: true });
  await incomeInvoicesService.finalizar(E, r.id, { fechaEmision: '2027-08-05' });
  await motor.contabilizarFacturaIngreso(E, r.id);
}

/** Pasa los apuntes de las subcuentas de terceros a la cuenta generica y las quita de fichas y plan. */
async function aCuentasGenericas() {
  const lineas = await prisma.journalEntryLine.findMany({
    where: { entry: { companyId: E }, OR: ['430', '400', '410'].map((p) => ({ accountCode: { startsWith: p } })) },
    select: { id: true, accountCode: true },
  });
  for (const l of lineas) {
    if (esSubcuentaDeTercero(l.accountCode)) await prisma.journalEntryLine.update({ where: { id: l.id }, data: { accountCode: l.accountCode.slice(0, 3) } });
  }
  await prisma.customer.updateMany({ where: { companyId: E }, data: { subcuenta430: null } });
  await prisma.supplier.updateMany({ where: { companyId: E }, data: { subcuenta400: null, subcuenta410: null } });
  const plan = await prisma.chartOfAccounts.findMany({ where: { companyId: E, OR: ['430', '400', '410'].map((p) => ({ codigo: { startsWith: p } })) }, select: { id: true, codigo: true } });
  const sobran = plan.filter((c) => esSubcuentaDeTercero(c.codigo)).map((c) => c.id);
  await prisma.chartOfAccounts.deleteMany({ where: { id: { in: sobran } } });
}

describe('modelos con subcuentas por tercero', () => {
  it('los datos sembrados van de verdad a las subcuentas 430N, 400N y 410N', async () => {
    const codigos = (await prisma.journalEntryLine.findMany({ where: { entry: { companyId: E } }, select: { accountCode: true } })).map((l) => l.accountCode);
    for (const p of ['430', '400', '410']) {
      expect(codigos.some((c) => c.startsWith(p) && c.length > 3 && esSubcuentaDeTercero(c))).toBe(true);
    }
    expect(codigos.filter((c) => ['430', '400', '410'].includes(c))).toEqual([]);
  });

  it('las cifras de cada modelo son las esperadas', () => {
    const m = conSubcuentas as Record<string, { errores?: string[]; casillas: Record<string, unknown>; registros: Array<{ nombre: string; importe: number }> | null }>;
    // Todo se puede presentar; el 349 del 1T no tiene operaciones intracomunitarias.
    expect(Object.keys(m).filter((k) => m[k].errores?.length)).toEqual(['349 1T']);
    // 347 por tercero (NIF): el proveedor con 400N y 410N es un solo declarado con todo lo del año.
    const declarados347 = (m['347 0A'].registros ?? []).map((r) => [r.nombre, r.importe]).sort();
    expect(declarados347).toEqual(
      [
        ['Bar Lector SL', 4840],
        // 3.630 € de la venta de febrero; la de mayo (2.420 €) y su rectificativa se anulan.
        ['Ferretería López SL', 3630],
        // 4.840 € de mercaderías (400N) + 605 € de suministros (410N).
        ['Mayorista Turia SL', 5445],
        // 3.630 € con IVA + 300 € exentos.
        ['Papelería Lectora SL', 3930],
      ].sort(),
    );
    expect(m['349 2T'].registros?.map((r) => [r.nombre, r.importe])).toEqual([['Müller Handels GmbH', 5000]]);
    expect(m['115 1T'].casillas).toMatchObject({ '02': 1500, '03': 285 });
    expect(m['111 2T'].casillas).toMatchObject({ '07': 1, '08': 2000, '09': 300 });
    expect(m['180 0A'].casillas).toMatchObject({ num_perceptores: 1, base_retenciones: 4500, retenciones: 855 });
    expect(m['190 0A'].casillas).toMatchObject({ num_perceptores: 1, importe_percepciones: 2000, retenciones_ingresos_cuenta: 300 });
    // 2T: compra leida (sin su parte exenta), profesional y alquiler en [28]/[29].
    expect(m['303 2T'].casillas).toMatchObject({ '28': 3000 + 2000 + 1500, '29': 630 + 420 + 315 });
    // 3T: la compra a Italia (país ISO-2 de la ficha, al 0 %) se autoliquida al 21 % y se deduce, como la ve el 349.
    expect(m['303 3T'].casillas).toMatchObject({ '10': 2500, '11': 525, '36': 2500, '37': 525 });
    expect(m['349 3T'].registros?.map((r) => [r.nombre, r.importe])).toEqual([['Rossi SpA', 2500]]);
  });

  it('con las cuentas genericas sale exactamente lo mismo', async () => {
    await aCuentasGenericas();
    const quedan = await prisma.journalEntryLine.findMany({ where: { entry: { companyId: E }, accountCode: { in: ['430', '400', '410'] } }, select: { accountCode: true } });
    expect(new Set(quedan.map((l) => l.accountCode))).toEqual(new Set(['430', '400', '410']));
    expect(await todosLosModelos()).toEqual(conSubcuentas);
  });
});
