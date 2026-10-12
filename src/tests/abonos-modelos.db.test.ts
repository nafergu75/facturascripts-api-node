/**
 * Abonos y rectificativas de proveedor en los modelos (seccion 10 de la
 * especificacion), sobre BD real:
 *  - 303: cada fila de la tabla 10.1 (art. 80 que reduce o aumenta en
 *    [40]/[41]; ERROR_IVA que reduce, en el periodo de la original neteando en
 *    [28]/[29]; intracomunitaria en [14]/[15] y [40]/[41]);
 *  - 390: [639]/[62] y [29]/[30] iguales a la suma de [40]/[41] y [14]/[15] de
 *    los cuatro 303, sin contar dos veces;
 *  - 347: fecha contable, signo y umbral en valor absoluto;
 *  - 349: registro de rectificacion del periodo de la original, resta en el
 *    normal si es del mismo periodo, y base declarada a mano si la original es
 *    de fuera de la app;
 *  - 111 y 115: la retencion de un abono resta como mucho hasta cero y el
 *    exceso se avisa (decision P1); 180 y 190 con saldo negativo.
 *
 * Necesita MySQL (en GitHub Actions lo levanta el workflow de tests).
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import { prisma } from '../config/database';
import { proveedoresService } from '../services/proveedores.service';
import { registrarGasto } from '../services/expense-invoices.service';
import { asegurarPlanContableEmpresa } from '../services/chart-of-accounts.service';
import { calcularModelo111, calcularModelo115, calcularModelo303, calcularModelo347, obtenerFacturasFiscales } from '../services/impuestosCalculo.service';
import { entrada390Desde } from '../services/borradoresAeat.service';
import { calcularBorrador349 } from '../services/borradoresAeat/borrador349.service';
import { calcularBorrador180 } from '../services/borradoresAeat/borrador180.service';
import { guardarOpciones } from '../services/borradoresAeat/comun';
import { crearInmueble } from '../services/borradoresAeat/inmuebles.service';
import { periodoFiscal } from '../services/nominas/fiscal';
import { aCentimos } from '../utils/money';
import { controlCif, letraDni } from '../utils/nif';

const SUFIJO = Date.now();
let n = 0;
function cif(): string {
  const siete = String(1000000 + ((SUFIJO + n++ * 7919) % 8999999)).slice(0, 7);
  return `B${siete}${controlCif(siete).cifra}`;
}
function dni(): string {
  const ocho = String(10000000 + ((SUFIJO + n++ * 104729) % 89999999)).slice(0, 8);
  return `${ocho}${letraDni(ocho)}`;
}

async function empresa(nombre: string): Promise<string> {
  const E = `abomod-${nombre}-${SUFIJO}`;
  await prisma.company.create({ data: { id: E, name: `Abonos ${nombre} SL`, fsBaseUrl: 'http://localhost', fsApiKeyEnc: 'k' } });
  await prisma.legalConfig.create({ data: { companyId: E, denominacion: `Abonos ${nombre}, S.L.`, nif: cif(), telefono: '963 11 22 33', personaContacto: 'Gómez Ruiz Ana' } });
  await asegurarPlanContableEmpresa(E);
  return E;
}

const lin = (precio: number, extra: Record<string, unknown> = {}) => ({ descripcion: 'Concepto', cantidad: 1, precioUnitario: precio, tipoIva: 21, ...extra });

async function gasto(E: string, supplierId: string, numero: string, fecha: string, lineas: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) {
  return registrarGasto(E, { proveedor: { id: supplierId }, numeroFacturaProveedor: numero, fechaEmision: fecha, tipoGasto: 'COMPRA', lineas, ...extra }, { contabilizar: 'POSTED' });
}

const rect = (causa: string, originales: Array<Record<string, unknown>>) => ({ rectificativa: { tipo: 'I', causa, originales } });

async function c303(E: string, periodo: string) {
  return (await calcularModelo303(E, periodoFiscal(2027, periodo))).casillasOficiales ?? {};
}

describe('303 y 390 con abonos y rectificativas de proveedor', () => {
  let E: string;
  let nacional: string;
  let italiano: string;

  beforeAll(async () => {
    E = await empresa('iva');
    nacional = (await proveedoresService.create(E, { nombreFiscal: 'Mayorista Turia SL', nifCif: cif(), cp: '46001' })).id;
    italiano = (await proveedoresService.create(E, { nombreFiscal: 'Rossi SpA', nifCif: 'IT12345678901', pais: 'IT' })).id;

    const o = await gasto(E, nacional, 'F-1', '2027-02-10', [lin(1000)]);
    // 2T: devolución (art. 80, reduce) y error de derecho que aumenta.
    await gasto(E, nacional, 'R-1', '2027-04-15', [lin(-100, { cuenta: '608' })], rect('DEVOLUCION', [{ id: o.factura.id }]));
    await gasto(E, nacional, 'R-2', '2027-04-20', [lin(50)], rect('ERROR_DERECHO', [{ id: o.factura.id }]));
    // 2T: error en el IVA que reduce (21 % → 10 %): se imputa al 1T de la original.
    await gasto(E, nacional, 'R-3', '2027-05-10', [lin(-100), lin(100, { tipoIva: 10 })], rect('ERROR_IVA', [{ id: o.factura.id }]));
    // Intracomunitaria: original en el 1T, abono en el 2T.
    const oi = await gasto(E, italiano, 'IT-1', '2027-01-20', [lin(1000, { tipoIva: 0 })]);
    await gasto(E, italiano, 'IT-1R', '2027-06-01', [lin(-200, { tipoIva: 0, cuenta: '608' })], rect('DEVOLUCION', [{ id: oi.factura.id }]));
  });

  it('el abono por art. 80 y el aumento van a [40]/[41] del periodo en que se reciben', async () => {
    const c = await c303(E, '2T');
    // -100 y +50 interiores, y -200 de la intracomunitaria (deducible).
    expect([c['40'], c['41']]).toEqual([-250, -52.5]);
    expect([c['28'] ?? 0, c['29'] ?? 0]).toEqual([0, 0]);
  });

  it('la intracomunitaria rectificada resta el autodevengo en [14]/[15]', async () => {
    const c = await c303(E, '2T');
    expect([c['14'], c['15']]).toEqual([-200, -42]);
  });

  it('ERROR_IVA que reduce: entra en el 303 del 1T (el de la original) neteando en [28]/[29], no en el del 2T', async () => {
    const c1 = await c303(E, '1T');
    expect([c1['28'], c1['29']]).toEqual([1000, 199]);
    const f = await prisma.expenseInvoice.findFirstOrThrow({ where: { companyId: E, numeroFacturaProveedor: 'R-3' } });
    expect(f.fechaImputacionIva).toBe('2027-02-10');
  });

  it('el 390 lleva a [639]/[62] y [29]/[30] lo mismo que los cuatro 303, sin repetirlo en las filas por tipo', async () => {
    const facturas = await obtenerFacturasFiscales(E, '2027-01-01', '2027-12-31');
    const { entrada } = entrada390Desde(facturas, 2027, { nif: 'B00000000', razonSocial: 'X' } as never);
    let s40 = 0;
    let s41 = 0;
    let s14 = 0;
    let s15 = 0;
    for (const t of ['1T', '2T', '3T', '4T']) {
      const c = await c303(E, t);
      s40 += aCentimos(c['40'] ?? 0);
      s41 += aCentimos(c['41'] ?? 0);
      s14 += aCentimos(c['14'] ?? 0);
      s15 += aCentimos(c['15'] ?? 0);
    }
    expect([aCentimos(entrada.rectificacionDeducciones?.base ?? 0), aCentimos(entrada.rectificacionDeducciones?.cuota ?? 0)]).toEqual([s40, s41]);
    expect([aCentimos(entrada.modificaciones?.base ?? 0), aCentimos(entrada.modificaciones?.cuota ?? 0)]).toEqual([s14, s15]);
    // Las filas interiores por tipo: la original y la ERROR_IVA (neteada), sin los abonos.
    expect(entrada.deducibleInterior.find((d) => d.tipo === 21)).toEqual({ tipo: 21, base: 900, cuota: 189 });
    expect(entrada.deducibleInterior.find((d) => d.tipo === 10)).toEqual({ tipo: 10, base: 100, cuota: 10 });
  });
});

describe('347: fecha contable, signo y umbral en valor absoluto', () => {
  it('un abono de 4.000 € de una venta de 2026 va en negativo en el 1T de 2027 y el tercero se declara', async () => {
    const E = await empresa('347');
    const p = (await proveedoresService.create(E, { nombreFiscal: 'Proveedor Grande SL', nifCif: cif(), cp: '46001' })).id;
    await gasto(E, p, 'AB-1', '2027-01-15', [lin(-4000, { tipoIva: 0 })], rect('DEVOLUCION', [{ numero: 'F-2026/9', fecha: '2026-11-30' }]));
    const m = await calcularModelo347(E, 2027);
    expect(m.operaciones).toEqual([expect.objectContaining({ tipo: 'proveedor', baseAnual: -4000, trimestres: [-4000, 0, 0, 0] })]);
  });

  it('una ERROR_IVA de febrero de 2027 sobre una original de noviembre de 2026 resta en el 1T de 2027', async () => {
    const E = await empresa('347b');
    const p = (await proveedoresService.create(E, { nombreFiscal: 'Proveedor Medio SL', nifCif: cif(), cp: '46001' })).id;
    await gasto(E, p, 'F-A', '2027-01-05', [lin(5000)]);
    await gasto(E, p, 'R-A', '2027-02-10', [lin(-1000), lin(1000, { tipoIva: 10 })], rect('ERROR_IVA', [{ numero: 'F-2026/77', fecha: '2026-11-30' }]));
    const m = await calcularModelo347(E, 2027);
    expect(m.operaciones[0].trimestres).toEqual([6050 - 110, 0, 0, 0]);
    expect((await calcularModelo347(E, 2026)).operaciones).toEqual([]);
  });
});

describe('349 con abonos de compras intracomunitarias', () => {
  let E: string;
  let italiano: string;

  beforeAll(async () => {
    E = await empresa('349');
    italiano = (await proveedoresService.create(E, { nombreFiscal: 'Rossi SpA', nifCif: 'IT12345678901', pais: 'IT' })).id;
    const o1 = await gasto(E, italiano, 'IT-10', '2027-02-01', [lin(1000, { tipoIva: 0 })]);
    await gasto(E, italiano, 'IT-10R', '2027-04-10', [lin(-100, { tipoIva: 0, cuenta: '608' })], rect('DEVOLUCION', [{ id: o1.factura.id }]));
    const o2 = await gasto(E, italiano, 'IT-20', '2027-05-01', [lin(500, { tipoIva: 0 })]);
    await gasto(E, italiano, 'IT-20R', '2027-05-20', [lin(-50, { tipoIva: 0, cuenta: '608' })], rect('DEVOLUCION', [{ id: o2.factura.id }]));
    await gasto(E, italiano, 'IT-30R', '2027-06-05', [lin(-200, { tipoIva: 0, cuenta: '608' })], rect('DEVOLUCION', [{ numero: 'IT-2026/5', fecha: '2026-11-20' }]));
  });

  it('original del trimestre anterior: registro de rectificación; del mismo trimestre: resta en el normal; de fuera de la app: pide la base declarada', async () => {
    const b = await calcularBorrador349(E, 2027, '2T');
    expect(b.entrada.operadores).toEqual([expect.objectContaining({ clave: 'A', base: 450 })]);
    expect(b.entrada.rectificaciones).toEqual([expect.objectContaining({ clave: 'A', ejercicio: 2027, periodo: '1T', baseAnterior: 1000, baseRectificada: 900 })]);
    expect(b.basesPedidas).toEqual([expect.objectContaining({ ejercicio: 2026, periodo: '4T', base: null, claveOperacion: 'A' })]);
    expect(b.errores).toContainEqual('Indica la base que declaraste para Rossi SpA (clave A) en el 349 del 4T de 2026: sin ella no se puede rectificar.');
  });

  it('con la base declarada guardada en las opciones, rectifica ese periodo', async () => {
    const pedida = (await calcularBorrador349(E, 2027, '2T')).basesPedidas[0];
    await guardarOpciones(E, '349', 2027, '2T', { [`base:${pedida.clave}`]: 5000 });
    const b = await calcularBorrador349(E, 2027, '2T');
    expect(b.errores.filter((e) => e.startsWith('Indica la base'))).toEqual([]);
    expect(b.entrada.rectificaciones).toContainEqual(expect.objectContaining({ ejercicio: 2026, periodo: '4T', baseAnterior: 5000, baseRectificada: 4800 }));
  });
});

describe('349 con un rappel que abarca varios trimestres', () => {
  let E: string;
  let italiano: string;

  beforeAll(async () => {
    E = await empresa('349r');
    italiano = (await proveedoresService.create(E, { nombreFiscal: 'Bianchi Srl', nifCif: 'IT98765432109', pais: 'IT' })).id;
    await gasto(E, italiano, 'B-1', '2027-01-20', [lin(1000, { tipoIva: 0 })]);
    await gasto(E, italiano, 'B-2', '2027-04-15', [lin(3000, { tipoIva: 0 })]);
  });

  it('sin reparto: por meses en proporción a lo comprado; la parte del 1T rectifica y la del 2T resta en el normal', async () => {
    const r = await gasto(E, italiano, 'RAP-1', '2027-05-10', [lin(-400, { tipoIva: 0, cuenta: '609' })], {
      rectificativa: { tipo: 'I', causa: 'RAPPEL', originales: [], periodo: { desde: '2027-01-01', hasta: '2027-06-30' } },
    });
    const filas = await prisma.expenseInvoiceRectificada.findMany({ where: { rectificativaId: r.factura.id }, orderBy: { periodoDesde: 'asc' } });
    expect(filas.map((f) => [f.periodoDesde, f.periodoHasta, f.baseRectificada])).toEqual([
      ['2027-01-01', '2027-01-31', -100],
      ['2027-04-01', '2027-04-30', -300],
    ]);
    const b = await calcularBorrador349(E, 2027, '2T');
    expect(b.entrada.operadores).toEqual([expect.objectContaining({ clave: 'A', base: 2700 })]);
    expect(b.entrada.rectificaciones).toEqual([expect.objectContaining({ clave: 'A', ejercicio: 2027, periodo: '1T', baseAnterior: 1000, baseRectificada: 900 })]);
    expect(b.avisos.filter((a) => /abarca varios periodos/.test(a))).toEqual([]);
  });

  it('con el reparto que pone la persona: cada tramo en su periodo', async () => {
    const r = await gasto(E, italiano, 'RAP-2', '2027-05-20', [lin(-200, { tipoIva: 0, cuenta: '609' })], {
      rectificativa: {
        tipo: 'I',
        causa: 'RAPPEL',
        originales: [],
        periodo: {
          desde: '2027-01-01',
          hasta: '2027-06-30',
          reparto: [
            { desde: '2027-01-01', hasta: '2027-03-31', base: -150 },
            { desde: '2027-04-01', hasta: '2027-06-30', base: -50 },
          ],
        },
      },
    });
    const filas = await prisma.expenseInvoiceRectificada.findMany({ where: { rectificativaId: r.factura.id }, orderBy: { periodoDesde: 'asc' } });
    expect(filas.map((f) => f.baseRectificada)).toEqual([-150, -50]);
    const b = await calcularBorrador349(E, 2027, '2T');
    expect(b.entrada.operadores).toEqual([expect.objectContaining({ base: 2650 })]);
    expect(b.entrada.rectificaciones).toEqual([expect.objectContaining({ periodo: '1T', baseAnterior: 1000, baseRectificada: 750 })]);
  });
});

describe('111, 115, 180 y 190 con la retención de un abono (decisión P1)', () => {
  let E: string;
  let asesor: string;
  let otro: string;
  let casero: string;

  beforeAll(async () => {
    E = await empresa('ret');
    asesor = (await proveedoresService.create(E, { nombreFiscal: 'Sanz Vidal Marta', nifCif: dni(), cp: '46005' })).id;
    otro = (await proveedoresService.create(E, { nombreFiscal: 'Pérez Gil Juan', nifCif: dni(), cp: '46006' })).id;
    casero = (await proveedoresService.create(E, { nombreFiscal: 'Martínez Peña José', nifCif: dni(), cp: '46004' })).id;
    const prof = (s: string, num: string, fecha: string, precio: number, extra: Record<string, unknown> = {}) =>
      gasto(E, s, num, fecha, [lin(precio, { tipoRetencion: 15 })], { tipoGasto: 'SERVICIO_PROFESIONAL', ...extra });
    const o = await prof(asesor, 'P-1', '2027-02-01', 1000);
    // 2T: otra factura con 90 € de retención y un abono de la de febrero con -150 €.
    await prof(otro, 'P-2', '2027-04-05', 600);
    await prof(asesor, 'P-1R', '2027-05-05', -1000, rect('ANULACION_PRECIO', [{ id: o.factura.id }]));
    // Alquiler: original en el 1T y abono en el 2T mayor que lo del 2T.
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
    const alq = (num: string, fecha: string, precio: number, extra: Record<string, unknown> = {}) =>
      gasto(E, casero, num, fecha, [lin(precio, { tipoRetencion: 19 })], { tipoGasto: 'ALQUILER', ...extra });
    const a1 = await alq('A-1', '2027-03-01', 1000);
    await alq('A-1R', '2027-04-01', -1000, rect('ANULACION_PRECIO', [{ id: a1.factura.id }]));
  });

  it('111 del 2T: [09] y [08] como mucho a cero, el exceso se avisa y quien solo tiene abonos no cuenta en [07]', async () => {
    const m = await calcularModelo111(E, periodoFiscal(2027, '2T'));
    expect(m).toMatchObject({ nPerceptoresActividades: 1, percepcionesActividades: 0, retencionesActividades: 0 });
    expect(m.avisos).toContainEqual(
      'La rectificativa P-1R resta 150,00 € de retención y en este periodo solo se pueden restar 90,00 €. Los 60,00 € restantes no se restan en ningún otro periodo: se recuperan pidiendo la rectificación del 111 del 1T de 2027, en el que se declararon (art. 120.3 LGT). En la contabilidad, pásalos de la 4751 a la 4709 (Hacienda deudora por devolución de impuestos).',
    );
  });

  it('111: el periodo siguiente no resta el exceso, y el del original no cambia', async () => {
    expect((await calcularModelo111(E, periodoFiscal(2027, '3T'))).retencionesActividades).toBe(0);
    expect((await calcularModelo111(E, periodoFiscal(2027, '1T'))).retencionesActividades).toBe(150);
  });

  it('115 del 2T: a cero con aviso; el abono hereda el inmueble de la original', async () => {
    const m = await calcularModelo115(E, periodoFiscal(2027, '2T'));
    expect(m).toMatchObject({ nPerceptores: 0, baseRetenciones: 0, retenciones: 0, excesoAbonos: 190 });
    expect(m.avisos?.[0]).toMatch(/^La rectificativa A-1R resta 190,00 € de retención y en este periodo solo se pueden restar 0,00 €/);
    const abono = await prisma.expenseInvoice.findFirstOrThrow({ where: { companyId: E, numeroFacturaProveedor: 'A-1R' } });
    const original = await prisma.expenseInvoice.findFirstOrThrow({ where: { companyId: E, numeroFacturaProveedor: 'A-1' } });
    expect(abono.inmuebleArrendadoId).toBe(original.inmuebleArrendadoId);
  });

  it('180: el arrendador se netea en el año (aquí a cero: no se declara)', async () => {
    const b = await calcularBorrador180(E, 2027);
    expect(b.entrada.perceptores).toEqual([]);
    expect(b.errores.filter((e) => /negativos/.test(e))).toEqual([]);
  });
});
