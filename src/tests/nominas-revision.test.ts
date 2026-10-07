/**
 * Arreglos de la revision de nominas, sin base de datos: 111 y 190 sin las
 * tablas de nominas (esquema sin aplicar), complementaria de seguros sociales,
 * trimestre del 111 de una fecha de pago, ejercicio de devengo de los atrasos
 * en el importador, mensajes con el nombre de cada campo, fila de titulos
 * detectada al mapear a mano, recibos del RETA en el lector de gastos,
 * desglose de profesionales por tipo y limpieza de subidas abandonadas.
 * Los NIF son inventados (numeros con su letra de control).
 */
jest.mock('../config/database', () => {
  // La tabla Nomina no existe (P2021): el esquema no se ha aplicado todavia.
  const { Prisma } = jest.requireActual('@prisma/client');
  const sinTabla = () => Promise.reject(new Prisma.PrismaClientKnownRequestError('The table `Nomina` does not exist in the current database.', { code: 'P2021', clientVersion: '5.22.0' }));
  return {
    prisma: {
      nomina: { findMany: () => sinTabla() },
      empleado: { findMany: () => sinTabla() },
      nominaResumen: { findMany: async () => [], count: async () => 0 },
      expenseInvoice: { findMany: async () => [] },
      modeloImpuesto: { findMany: async () => [] },
    },
  };
});

import { promises as fsp } from 'fs';
import * as path from 'path';
import { letraNif } from '../utils/nif';
import { calcularModelo111 } from '../services/impuestosCalculo.service';
import { AVISO_SIN_TABLAS, calcularModelo190, desgloseActividadesPorTipo, periodoFiscal, retenciones111Guardadas } from '../services/nominas/fiscal';
import { previstoPendienteCentimos } from '../services/nominas/segurosSociales';
import { trimestre111 } from '../services/nominas/tesoreria';
import { conceptoAsientoNomina, conceptoSubcuenta465 } from '../services/nominas/calculo';
import { filasDesdeJson, leerNominasDeFilas } from '../services/nominas/lector';
import { empleadoCrearSchema, parsear } from '../services/nominas/esquemas';
import { clasificarDocumentoGasto } from '../services/gastos-extractor.service';
import { limpiarSubidasCaducadas, recibirTrozo } from '../services/puestaEnMarcha/subidasTrozos';
import { cambiosNomina } from '../controllers/nominas.controller';
import { HttpError } from '../utils/http-errors';

const nif = (n: number) => `${String(n).padStart(8, '0')}${letraNif(n)}`;

describe('111 y 190 sin las tablas de nominas (codigo desplegado antes de aplicar el esquema)', () => {
  it('el 111 sale sin nominas y con un aviso, no con un 500', async () => {
    const d = await calcularModelo111('empresa-sin-tablas', periodoFiscal(2026, '1T'));
    expect(d).toMatchObject({ nPerceptoresTrabajo: 0, retencionesTrabajo: 0, totalRetenciones: 0 });
    expect(d.avisos).toContain(AVISO_SIN_TABLAS);
  });

  it('el 190 tambien', async () => {
    const m = await calcularModelo190('empresa-sin-tablas', 2026);
    expect(m.perceptores).toEqual([]);
    expect(m.avisos).toContain(AVISO_SIN_TABLAS);
  });
});

describe('seguros sociales: lo que le toca a cada liquidacion', () => {
  const fila = (id: string, tipo: string, estado: string, totalPrevisto: number) => ({ id, tipo, estado, totalPrevisto });

  it('NORMAL sin pagos: todo lo de las nominas; COMPLEMENTARIA sin el normal pagado: nada (va a la 642)', () => {
    expect(previstoPendienteCentimos('NORMAL', { totalPrevisto: 5000 }, [])).toBe(500000);
    expect(previstoPendienteCentimos('COMPLEMENTARIA', { totalPrevisto: 5000 }, [fila('n', 'NORMAL', 'PENDIENTE', 0)])).toBe(0);
  });

  it('COMPLEMENTARIA con el normal pagado: la SS de las nominas contabilizadas despues (sale de la 476, no de la 642)', () => {
    const filas = [fila('n', 'NORMAL', 'PAGADA', 5000), fila('c', 'COMPLEMENTARIA', 'PENDIENTE', 0)];
    expect(previstoPendienteCentimos('COMPLEMENTARIA', { totalPrevisto: 5360 }, filas, 'c')).toBe(36000);
    // Ya pagada esa complementaria, no queda nada para otra.
    expect(previstoPendienteCentimos('COMPLEMENTARIA', { totalPrevisto: 5360 }, [fila('n', 'NORMAL', 'PAGADA', 5000), fila('c', 'COMPLEMENTARIA', 'PAGADA', 360)], 'otra')).toBe(0);
  });
});

describe('trimestre del 111 de una fecha de pago y casillas guardadas', () => {
  it('trimestres', () => {
    expect(trimestre111('2026-12-31')).toEqual({ ejercicio: 2026, periodo: '4T' });
    expect(trimestre111('2027-01-05')).toEqual({ ejercicio: 2027, periodo: '1T' });
    expect(trimestre111('2026-08-31')).toEqual({ ejercicio: 2026, periodo: '3T' });
  });

  it('retenciones de un 111 guardado: 03 + 06 + 09 (o la 28 en formatos viejos); null si no es de este formato', () => {
    expect(retenciones111Guardadas({ '03_retenciones_trabajo': 300, '06_ingresos_a_cuenta': 15, '09_retenciones_actividades': 150, '28_total_retenciones': 465 })).toBe(465);
    expect(retenciones111Guardadas({ '28_total_retenciones': 99 })).toBe(99);
    expect(retenciones111Guardadas({ '03': 1 })).toBeNull();
    expect(retenciones111Guardadas(null)).toBeNull();
  });
});

describe('asientos sin el nombre del trabajador', () => {
  it('concepto y subcuenta 465 por el codigo', () => {
    expect(conceptoAsientoNomina({ ejercicio: 2026, mes: 5, tipo: 'EXTRA' }, '4650003')).toBe('Paga extra 05/2026 - trabajador 4650003');
    expect(conceptoSubcuenta465('4650003')).toBe('Remuneraciones pendientes - trabajador 4650003');
  });
});

describe('importador: ejercicio de devengo de los atrasos y mensajes', () => {
  const CAB = ['Trabajador', 'NIF', 'Mes', 'Tipo', 'Ejercicio devengo', 'Total devengado', 'IRPF', 'Líquido a percibir'];

  it('lee la columna "Ejercicio devengo"; atrasos sin ella, con aviso; posterior al de la nomina, error', () => {
    const l = leerNominasDeFilas([
      CAB,
      ['Uno', nif(70000001), '03/2026', 'Atrasos', 2025, 500, 50, 450],
      ['Dos', nif(70000002), '03/2026', 'Atrasos', '', 500, 50, 450],
      ['Tres', nif(70000003), '03/2026', 'Atrasos', 2027, 500, 50, 450],
    ]);
    expect(l.mapeo.ejercicioDevengo).toBe(4);
    expect(l.filas[0]).toMatchObject({ tipo: 'ATRASOS', ejercicioDevengo: 2025, errores: [] });
    expect(l.filas[1].ejercicioDevengo).toBeNull();
    expect(l.filas[1].avisos.join(' ')).toMatch(/sin ejercicio de devengo/);
    expect(l.filas[2].errores.join(' ')).toMatch(/posterior al de la nómina/);
  });

  it('las filas ya revisadas (JSON) traen el ejercicio de devengo', () => {
    const [f] = filasDesdeJson([{ nif: nif(70000001), nombre: 'Uno', ejercicio: 2026, mes: 3, tipo: 'ATRASOS', ejercicioDevengo: 2025, brutoDinerario: 500, irpf: 50, liquido: 450 }]);
    expect(f).toMatchObject({ ejercicioDevengo: 2025, errores: [] });
  });

  it('un liquido negativo tiene su propio mensaje; los importes, su nombre y no la clave interna', () => {
    const l = leerNominasDeFilas([
      ['Trabajador', 'NIF', 'Mes', 'Total devengado', 'Líquido a percibir'],
      ['Uno', nif(70000001), '03/2026', 0, -50],
    ]);
    const errores = l.filas[0].errores.join(' ');
    expect(errores).toMatch(/líquido a percibir es negativo/);
    expect(errores).toMatch(/regístrala a mano/);
    expect(errores).not.toMatch(/"liquido"/);
  });

  it('sin columnas reconocibles, la vista previa indica la fila de titulos detectada (no la 1)', () => {
    const filas = [['Empresa Prueba SL'], ['NÓMINAS ENERO 2026'], [], ['Persona', 'DNI', 'Importe a cobrar', 'Líquido'], ['Uno', nif(70000001), 1000, 900]];
    let detalle: Record<string, unknown> | undefined;
    try {
      leerNominasDeFilas(filas);
    } catch (e) {
      detalle = (e as HttpError).details as Record<string, unknown>;
    }
    expect(detalle).toMatchObject({ necesitaMapeo: true, filaCabecera: 4 });
    expect((detalle!.columnas as Array<{ titulo: string }>).map((c) => c.titulo)).toEqual(['Persona', 'DNI', 'Importe a cobrar', 'Líquido']);
  });

  it('los errores de validacion usan el nombre del campo', () => {
    let mensaje = '';
    try {
      parsear(empleadoCrearSchema, { nif: nif(70000001), nombre: 'Uno', anioNacimiento: 85, subclave190: '1' });
    } catch (e) {
      mensaje = (e as Error).message;
    }
    expect(mensaje).toMatch(/Año de nacimiento: año no válido/);
    expect(mensaje).toMatch(/Subclave del 190: dos dígitos/);
    expect(mensaje).not.toMatch(/anioNacimiento|subclave190/);
  });
});

describe('auditoria de la edicion de una nomina', () => {
  it('solo los campos que cambian, con el valor de antes y el de despues', () => {
    expect(cambiosNomina({ irpf: 300, liquido: 1573, fechaPago: '2026-01-31' }, { irpf: 320, liquido: 1553, fechaPago: '2026-01-31' })).toEqual({
      irpf: { antes: 300, despues: 320 },
      liquido: { antes: 1573, despues: 1553 },
    });
  });
});

describe('lector de gastos: la cuota de autonomos no son seguros sociales', () => {
  it('RETA o autonomos sin tipo: factura (se registra como gasto)', () => {
    expect(clasificarDocumentoGasto({ concepto: 'Cuota de autónomos RETA', iva_cantidad: null, iva_porcentaje: null })).toBe('factura');
    expect(clasificarDocumentoGasto({ concepto: 'Seguridad Social', iva_cantidad: null, iva_porcentaje: null })).toBe('seguros_sociales');
  });
});

describe('profesionales por el tipo de retencion de sus facturas', () => {
  it('15 % y 7 % por separado, no un tipo medio', () => {
    expect(
      desgloseActividadesPorTipo([
        { supplierId: 'p1', baseTotal: 1000, retencionTotal: 150, tipoRetencion: 15 },
        { supplierId: 'p2', baseTotal: 1000, retencionTotal: 70, tipoRetencion: 7 },
        { supplierId: 'p1', baseTotal: 1000, retencionTotal: 150, tipoRetencion: 15 },
      ]),
    ).toEqual([
      { porcentaje: 15, perceptores: 1, base: 2000, cuota: 300 },
      { porcentaje: 7, perceptores: 1, base: 1000, cuota: 70 },
    ]);
  });
});

describe('subidas por trozos abandonadas', () => {
  const EMPRESA = `subidas-test-${Date.now()}`;
  afterAll(async () => {
    await fsp.rm(path.join(process.cwd(), 'storage', 'puesta-en-marcha', 'subidas', EMPRESA), { recursive: true, force: true });
  });

  it('se borran las de mas de 24 horas', async () => {
    const r = await recibirTrozo(EMPRESA, { indice: 0, total: 2, nombre: 'nominas.xlsx', tamano: 10 }, Buffer.from('01234'));
    const carpeta = path.join(process.cwd(), 'storage', 'puesta-en-marcha', 'subidas', EMPRESA, r.subidaId);
    const hace2dias = new Date(Date.now() - 2 * 24 * 3600 * 1000);
    for (const f of await fsp.readdir(carpeta)) await fsp.utimes(path.join(carpeta, f), hace2dias, hace2dias);
    await limpiarSubidasCaducadas(EMPRESA);
    expect(await fsp.readdir(carpeta).catch(() => [])).toEqual([]);
  });
});
