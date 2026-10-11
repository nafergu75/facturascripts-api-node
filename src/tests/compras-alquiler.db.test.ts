/**
 * Retenciones de alquiler sobre BD real: las facturas de ALQUILER con
 * retencion salen del 111 y del 190 y van al 115 (que antes salia siempre a
 * cero), y el libro de retenciones dice ARRENDAMIENTO. El resumen anual del 115
 * da los datos del 180 por arrendador. Las anuladas siguen el criterio fiscal
 * unico: sin contraasiento no cuentan; con contraasiento restan en su periodo.
 *
 * Necesita MySQL (en GitHub Actions lo levanta el workflow de tests).
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { prisma } from '../config/database';
import { expenseInvoicesService } from '../services/expense-invoices.service';
import { calcularModelo111, calcularModelo115 } from '../services/impuestosCalculo.service';
import { calcularModelo190, periodoFiscal } from '../services/nominas/fiscal';
import { cambiarEstadoPeriodo } from '../services/periodos.service';
import taxModelsRoutes from '../routes/tax-models.routes';
import { errorMiddleware } from '../middleware/error.middleware';
import { controlCif, letraNif } from '../utils/nif';

const SUFIJO = `${Date.now()}`;
let n = 0;
const cif = () => {
  const siete = String(2000000 + ((Date.now() + n++ * 104729) % 7999999)).slice(0, 7);
  return `B${siete}${controlCif(siete).cifra}`;
};

async function nuevaEmpresa(nombre: string): Promise<string> {
  const id = `compras-alq-${nombre}-${SUFIJO}`;
  await prisma.company.create({ data: { id, name: `Alquiler ${nombre} SL`, fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
  await prisma.legalConfig.create({ data: { companyId: id, denominacion: `Alquiler ${nombre} SL`, nif: 'B10000008' } });
  return id;
}

/** DNI inventado con su letra: los profesionales del 190 (clave G) son personas fisicas. */
const dni = () => {
  const numero = 10000000 + ((Date.now() + n++ * 7919) % 89999999);
  return `${numero}${letraNif(numero)}`;
};

const proveedor = async (companyId: string, nombre: string, nifCif = cif()) =>
  (await prisma.supplier.create({ data: { companyId, nombreFiscal: nombre, nifCif, cp: '46001', provincia: 'Valencia' } })).id;

const alquiler = (supplierId: string, fecha: string, numero: string) => ({
  companyId: '',
  proveedor: { id: supplierId },
  numeroFacturaProveedor: numero,
  fechaEmision: fecha,
  tipoGasto: 'ALQUILER',
  lineas: [{ descripcion: 'Alquiler del local', cantidad: 1, precioUnitario: 1000, tipoIva: 21, tipoRetencion: 19 }],
});
const profesional = (supplierId: string, fecha: string, numero: string) => ({
  companyId: '',
  proveedor: { id: supplierId },
  numeroFacturaProveedor: numero,
  fechaEmision: fecha,
  tipoGasto: 'SERVICIO_PROFESIONAL',
  lineas: [{ descripcion: 'Asesoría', cantidad: 1, precioUnitario: 500, tipoIva: 21, tipoRetencion: 15 }],
});

const alta = (companyId: string, cuerpo: ReturnType<typeof alquiler>) =>
  expenseInvoicesService.crearGasto({ ...cuerpo, companyId }, { contabilizar: 'POSTED' });

function app(companyId: string) {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    req.user = { userId: 'u-alq', roles: ['contable'], companies: [companyId], rolesPorEmpresa: { [companyId]: ['contable'] } } as never;
    req.companyId = companyId;
    next();
  });
  a.use('/companies/:companyId/tax-models', taxModelsRoutes);
  a.use(errorMiddleware);
  return a;
}

describe('alquiler y profesional en el mismo trimestre', () => {
  let E: string;
  let arrendador: string;
  let asesor: string;

  beforeAll(async () => {
    E = await nuevaEmpresa('mixto');
    arrendador = await proveedor(E, 'Inmuebles Centro SL');
    asesor = await proveedor(E, 'Asesoría Ruiz', dni());
    await alta(E, alquiler(arrendador, '2026-02-01', 'ALQ-02'));
    await alta(E, profesional(asesor, '2026-02-10', 'AS-15'));
  });

  it('el 111 solo lleva al profesional', async () => {
    const m = await calcularModelo111(E, periodoFiscal(2026, '1T'));
    expect(m).toMatchObject({ nPerceptoresActividades: 1, percepcionesActividades: 500, retencionesActividades: 75 });
    expect(m.actividadesPorTipo).toEqual([{ porcentaje: 15, perceptores: 1, base: 500, cuota: 75 }]);
  });

  it('el 115 lleva el alquiler', async () => {
    const m = await calcularModelo115(E, periodoFiscal(2026, '1T'));
    expect(m).toMatchObject({ nPerceptores: 1, baseRetenciones: 1000, retenciones: 190, resultadoAnteriores: 0, resultadoIngresar: 190 });
    expect(m.perceptores).toEqual([expect.objectContaining({ nombre: 'Inmuebles Centro SL', base: 1000, retencion: 190, facturas: 1 })]);
  });

  it('el 190 no tiene a la arrendadora y sigue cuadrando con los 111', async () => {
    const m = await calcularModelo190(E, 2026);
    expect(m.perceptores.map((p) => [p.clave, p.nombre, p.retenciones])).toEqual([['G', 'Asesoría Ruiz', 75]]);
    expect(m.cuadre111.coincide).toBe(true);
  });

  it('el libro de retenciones dice ARRENDAMIENTO y PROFESIONAL', async () => {
    const filas = await prisma.retentionBook.findMany({ where: { companyId: E } });
    expect(filas.map((f) => [f.tipoRetencionNombre, f.cuotaRetencion]).sort()).toEqual([['ARRENDAMIENTO', 190], ['PROFESIONAL', 75]]);
  });

  it('GET /tax-models/115 del trimestre coincide con el modulo Impuestos', async () => {
    const r = await request(app(E)).get(`/companies/${E}/tax-models/115?ejercicio=2026&trimestre=1`);
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({
      ejercicio: 2026,
      trimestre: 1,
      baseImponible: 1000,
      retencion: 190,
      porcentajeRetencion: 19,
      operaciones: 1,
      estado: 'vigente',
      casillas: { '01': 1, '02': 1000, '03': 190, '04': 0, '05': 190 },
    });
    expect(r.body.data.perceptores).toHaveLength(1);
  });

  it('GET /tax-models/115 sin trimestre: el resumen anual por arrendador, sin guardar nada', async () => {
    const antes = await prisma.modeloImpuesto.count({ where: { companyId: E, codigo: '115' } });
    const r = await request(app(E)).get(`/companies/${E}/tax-models/115?ejercicio=2026`);
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ ejercicio: 2026, totalBase: 1000, totalRetenido: 190, estado: 'vigente', casillas: {} });
    expect(r.body.data.desgloseTrimestral).toHaveLength(4);
    expect(r.body.data.desgloseTrimestral[0]).toMatchObject({ numero: 1, base: 1000, cuota: 190, operaciones: 1, estado: 'vigente' });
    expect(r.body.data.desgloseTrimestral[1]).toMatchObject({ numero: 2, base: 0, cuota: 0 });
    expect(r.body.data.arrendadores).toEqual([expect.objectContaining({ nombre: 'Inmuebles Centro SL', base: 1000, retencion: 190, facturas: 1 })]);
    expect(await prisma.modeloImpuesto.count({ where: { companyId: E, codigo: '115' } })).toBe(antes);
  });
});

describe('anuladas en el 111 y el 115', () => {
  it('una anulada nunca resta: sin el 111/115 de su periodo presentado no cuenta en ninguno', async () => {
    const E = await nuevaEmpresa('anuladas');
    const arrendador = await proveedor(E, 'Locales Norte SL');
    const asesor = await proveedor(E, 'Abogada Sur', dni());

    // Periodo abierto: se anula y desaparece.
    const a1 = await alta(E, alquiler(arrendador, '2026-02-01', 'L-1'));
    const p1 = await alta(E, profesional(asesor, '2026-02-01', 'P-1'));
    await expenseInvoicesService.anularGasto(E, a1.id, { motivo: 'Duplicada' });
    await expenseInvoicesService.anularGasto(E, p1.id, { motivo: 'Duplicada' });
    expect((await calcularModelo115(E, periodoFiscal(2026, '1T'))).retenciones).toBe(0);
    expect((await calcularModelo111(E, periodoFiscal(2026, '1T'))).retencionesActividades).toBe(0);

    // Periodo cerrado sin el 111/115 presentado: contraasiento en abril, pero
    // los modelos de retenciones no la cuentan en ningun trimestre (ni restan).
    const a2 = await alta(E, alquiler(arrendador, '2026-01-15', 'L-2'));
    const p2 = await alta(E, profesional(asesor, '2026-01-15', 'P-2'));
    await cambiarEstadoPeriodo(E, 2026, 1, 'cerrado');
    const r1 = await expenseInvoicesService.anularGasto(E, a2.id, { motivo: 'Error del arrendador', fecha: '2026-04-10' });
    const r2 = await expenseInvoicesService.anularGasto(E, p2.id, { motivo: 'Error del asesor', fecha: '2026-04-10' });
    expect([r1.contraasiento, r2.contraasiento]).toEqual([true, true]);

    for (const t of ['1T', '2T']) {
      expect(await calcularModelo115(E, periodoFiscal(2026, t))).toMatchObject({ nPerceptores: 0, baseRetenciones: 0, retenciones: 0 });
      expect((await calcularModelo111(E, periodoFiscal(2026, t))).retencionesActividades).toBe(0);
    }
    const m190 = await calcularModelo190(E, 2026);
    expect(m190.totales.retenciones).toBe(0);
    expect(m190.perceptores.filter((p) => p.origen === 'profesional')).toEqual([]);
  });

  it('con el 111/115 de su periodo presentado: se queda alli con un aviso, y no resta en el de la anulacion', async () => {
    const E = await nuevaEmpresa('anuladas-presentadas');
    const arrendador = await proveedor(E, 'Locales Este SL');
    const asesor = await proveedor(E, 'Abogado Oeste', dni());
    const a = await alta(E, alquiler(arrendador, '2026-05-15', 'L-9'));
    const p = await alta(E, profesional(asesor, '2026-05-15', 'P-9'));
    for (const codigo of ['111', '115']) {
      await prisma.modeloImpuesto.create({ data: { companyId: E, codigo, ejercicio: 2026, periodo: '2T', estado: 'presentado' } });
    }
    const r1 = await expenseInvoicesService.anularGasto(E, a.id, { motivo: 'Error del arrendador', fecha: '2026-07-10' });
    const r2 = await expenseInvoicesService.anularGasto(E, p.id, { motivo: 'Error del asesor', fecha: '2026-07-10' });
    expect([r1.contraasiento, r2.contraasiento]).toEqual([true, true]);

    const m115 = await calcularModelo115(E, periodoFiscal(2026, '2T'));
    expect(m115).toMatchObject({ nPerceptores: 1, retenciones: 190 });
    expect(m115.avisos).toEqual([
      'La factura L-9 de Locales Este SL está anulada, pero su retención se declaró en el 115 del 2T de 2026: si no llegaste a pagarla, pide la rectificación de ese modelo.',
    ]);
    expect(await calcularModelo115(E, periodoFiscal(2026, '3T'))).toMatchObject({ nPerceptores: 0, baseRetenciones: 0, retenciones: 0, resultadoIngresar: 0 });
    const m111 = await calcularModelo111(E, periodoFiscal(2026, '2T'));
    expect(m111.retencionesActividades).toBe(75);
    expect(m111.avisos).toContain(
      'La factura P-9 de Abogado Oeste está anulada, pero su retención se declaró en el 111 del 2T de 2026: si no llegaste a pagarla, pide la rectificación de ese modelo.',
    );
    expect((await calcularModelo111(E, periodoFiscal(2026, '3T'))).retencionesActividades).toBe(0);
    // El 190 casa con los 111 presentados.
    expect((await calcularModelo190(E, 2026)).totales.retenciones).toBe(75);
  });
});
