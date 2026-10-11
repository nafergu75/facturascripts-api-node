/**
 * Configuración > Impuestos: ajustes fiscales y calendario de modelos.
 *
 *  - Calendario (puro): 303 mensual, 111/115 mensuales de gran empresa, sin
 *    390 ni 347 con SII, 130 en lugar del 200 para autónomos.
 *  - Cambio de ajustes: no toca lo presentado ni los periodos ya empezados (no
 *    es retroactivo); con aplicarDesde se adelanta (con el 1T presentado, desde
 *    abril). La lista de la pantalla sale de los modelos reales del año.
 *  - GET/PUT sobre BD real: reglas, permisos y empresa extranjera (409).
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { prisma } from '../config/database';
import ajustesFiscalesRoutes from '../routes/ajustesFiscales.routes';
import { errorMiddleware } from '../middleware/error.middleware';
import { calendarioEjercicio, planCambioCalendario, OPCIONES_CALENDARIO_POR_DEFECTO } from '../domain/calendarioFiscal';
import { AJUSTES_FISCALES_POR_DEFECTO } from '../domain/ajustes.model';
import { anioEspana } from '../utils/fechas';
import { guardarAjustesFiscales, obtenerAjustesFiscales, previsualizarAjustesFiscales } from '../services/ajustesFiscales.service';
import {
  autorrellenarModelo,
  calendarioFiscalSoloLectura,
  generarTxtModelo,
  listarModelosImpuesto,
  MENSAJE_130_MANUAL,
  obtenerDetalleModelo,
} from '../services/impuestosModulo.service';

const SUFIJO = Date.now();
const ES = `ajustes-fis-es-${SUFIJO}`;
const US = `ajustes-fis-us-${SUFIJO}`;
const AUT = `ajustes-fis-aut-${SUFIJO}`;
const TARDE = `ajustes-fis-tarde-${SUFIJO}`;

let rol = 'admin';
const app = express();
app.use(express.json());
app.use('/companies/:companyId', (req, _res, next) => {
  req.user = { userId: `u-${rol}`, roles: [rol], rolesPorEmpresa: { [req.params.companyId]: [rol] } } as never;
  req.companyId = req.params.companyId;
  next();
});
app.use('/companies/:companyId/ajustes-fiscales', ajustesFiscalesRoutes);
app.use(errorMiddleware);

const leer = (empresa = ES) => request(app).get(`/companies/${empresa}/ajustes-fiscales`);
const guardar = (body: object, empresa = ES) => request(app).put(`/companies/${empresa}/ajustes-fiscales`).send(body);

const mensual = { ...AJUSTES_FISCALES_POR_DEFECTO, periodicidadIva: 'MENSUAL' as const };
const codigos = (cal: Array<{ codigo: string; periodo: string }>, codigo: string) => cal.filter((c) => c.codigo === codigo).map((c) => c.periodo);

describe('calendarioEjercicio (puro)', () => {
  it('por defecto: trimestrales y anuales de siempre', () => {
    const cal = calendarioEjercicio(2026);
    expect(codigos(cal, '303')).toEqual(['1T', '2T', '3T', '4T']);
    expect(codigos(cal, '111')).toEqual(['1T', '2T', '3T', '4T']);
    expect(cal.filter((c) => c.periodo === '0A').map((c) => c.codigo)).toEqual(['390', '347', '200', '190', '180']);
    expect(codigos(cal, '130')).toEqual([]);
  });

  it('IVA mensual: doce 303', () => {
    const cal = calendarioEjercicio(2026, { ajustes: mensual, autonomo: false });
    expect(codigos(cal, '303')).toEqual(['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12']);
    expect(codigos(cal, '111')).toEqual(['1T', '2T', '3T', '4T']);
  });

  it('con SII, sin 390 ni 347; gran empresa: 111 y 115 mensuales', () => {
    const cal = calendarioEjercicio(2026, { ajustes: { ...mensual, sii: true, granEmpresa: true }, autonomo: false });
    expect(cal.some((c) => c.codigo === '390' || c.codigo === '347')).toBe(false);
    expect(codigos(cal, '111')).toHaveLength(12);
    expect(codigos(cal, '115')).toHaveLength(12);
    expect(codigos(cal, '349')).toEqual(['1T', '2T', '3T', '4T']);
  });

  it('autónomo: 130 trimestral y sin 200', () => {
    const cal = calendarioEjercicio(2026, { ...OPCIONES_CALENDARIO_POR_DEFECTO, autonomo: true });
    expect(codigos(cal, '130')).toEqual(['1T', '2T', '3T', '4T']);
    expect(codigos(cal, '200')).toEqual([]);
  });
});

describe('planCambioCalendario (puro)', () => {
  const filas = (estados: Record<string, string> = {}) =>
    calendarioEjercicio(2026).map((c, i) => ({ id: `f${i}`, ...c, estado: estados[`${c.codigo}:${c.periodo}`] ?? 'vigente', origen: null }));

  it('sin nada presentado: todo el año, también los anuales', () => {
    const plan = planCambioCalendario(2026, filas(), calendarioEjercicio(2026, { ajustes: { ...mensual, sii: true }, autonomo: false }));
    expect(plan.aplicadoDesde).toBe('2026-01-01');
    expect(plan.crear.filter((c) => c.codigo === '303')).toHaveLength(12);
    expect(plan.borrar).toHaveLength(4 + 2); // 303 1T..4T, 390 y 347
  });

  it('con el 1T presentado: desde abril, y los anuales no cambian', () => {
    const plan = planCambioCalendario(2026, filas({ '303:1T': 'presentado' }), calendarioEjercicio(2026, { ajustes: { ...mensual, sii: true }, autonomo: false }));
    expect(plan.aplicadoDesde).toBe('2026-04-01');
    expect(plan.crear.map((c) => c.periodo)).toEqual(['04', '05', '06', '07', '08', '09', '10', '11', '12']);
    expect(plan.borrar).toHaveLength(3); // 303 2T, 3T y 4T
  });

  it('no es retroactivo: empieza en el primer trimestre que aún no ha empezado', () => {
    const deseado = calendarioEjercicio(2026, { ajustes: { ...mensual, sii: true }, autonomo: false });
    expect(planCambioCalendario(2026, filas(), deseado, { hoy: '2026-04-10' }).aplicadoDesde).toBe('2026-07-01');
    expect(planCambioCalendario(2026, filas(), deseado, { hoy: '2026-07-01' }).aplicadoDesde).toBe('2026-07-01');
    // En octubre ya no queda ningún trimestre por empezar: desde el año que viene.
    expect(planCambioCalendario(2026, filas(), deseado, { hoy: '2026-10-07' })).toEqual({ aplicadoDesde: null, borrar: [], crear: [] });
    // Un año que todavía no ha empezado cambia entero.
    expect(planCambioCalendario(2026, filas(), deseado, { hoy: '2025-11-20' }).aplicadoDesde).toBe('2026-01-01');
  });

  it('aplicarDesde adelanta el cambio a un trimestre ya empezado, nunca por encima de lo presentado', () => {
    const deseado = calendarioEjercicio(2026, { ajustes: { ...mensual, sii: true }, autonomo: false });
    expect(planCambioCalendario(2026, filas(), deseado, { hoy: '2026-10-07', aplicarDesde: '2026-01-01' }).aplicadoDesde).toBe('2026-01-01');
    const conT1 = planCambioCalendario(2026, filas({ '303:1T': 'presentado' }), deseado, { hoy: '2026-10-07', aplicarDesde: '2026-01-01' });
    expect(conT1.aplicadoDesde).toBe('2026-04-01');
  });

  it('con el 4T presentado u omitido: este año ya no cambia', () => {
    const plan = planCambioCalendario(2026, filas({ '111:4T': 'omitido' }), calendarioEjercicio(2026, { ajustes: mensual, autonomo: false }));
    expect(plan).toEqual({ aplicadoDesde: null, borrar: [], crear: [] });
  });
});

describe('GET/PUT /ajustes-fiscales', () => {
  beforeAll(async () => {
    for (const [id, name] of [[ES, 'Fiscal SL'], [US, 'Fiscal Inc'], [AUT, 'Autonoma'], [TARDE, 'Configura Tarde SL']]) {
      await prisma.company.create({ data: { id, name, fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
    }
    await prisma.legalConfig.create({ data: { companyId: US, pais: 'US', monedaCuenta: 'USD' } });
    await prisma.legalConfig.create({ data: { companyId: AUT, tipoSociedad: 'AUTONOMO' } });
  });

  it('sin fila: los de por defecto, sin crearla, con el calendario del año', async () => {
    const res = await leer();
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ periodicidadIva: 'TRIMESTRAL', redeme: false, sii: false, granEmpresa: false, guardado: false, autonomo: false });
    expect(res.body.data.noDisponibles).toEqual(['recargoEquivalencia', 'criterioCaja', 'prorrata']);
    expect(res.body.data.calendario.modelos.filter((m: { codigo: string }) => m.codigo === '303')).toHaveLength(4);
    expect(await prisma.ajustesFiscales.count({ where: { companyId: ES } })).toBe(0);
  });

  it('reglas: gran empresa y REDEME obligan a SII; IVA mensual y SII van juntos; RE, caja y prorrata aún no', async () => {
    const casos: Array<[object, string]> = [
      [{ granEmpresa: true, periodicidadIva: 'MENSUAL' }, 'sii'],
      [{ redeme: true, periodicidadIva: 'MENSUAL' }, 'sii'],
      [{ periodicidadIva: 'MENSUAL' }, 'sii'],
      [{ sii: true }, 'periodicidadIva'],
      [{ redeme: true, periodicidadIva: 'TRIMESTRAL' }, 'periodicidadIva'],
      [{ recargoEquivalencia: true }, 'recargoEquivalencia'],
      [{ criterioCaja: true }, 'criterioCaja'],
      [{ prorrata: 50 }, 'prorrata'],
      [{ periodicidadIva: 'ANUAL' }, 'periodicidadIva'],
      [{ otra: 1 }, 'otra'],
    ];
    for (const [body, campo] of casos) {
      const res = await guardar(body);
      expect([res.status, res.body.details]).toEqual([400, { campo }]);
    }
    expect(await prisma.ajustesFiscales.count({ where: { companyId: ES } })).toBe(0);
  });

  it('permisos: el comercial no los ve; el de solo lectura no los cambia; el contable sí', async () => {
    rol = 'ventas';
    expect((await leer()).status).toBe(403);
    rol = 'solo_lectura';
    expect((await leer()).status).toBe(200);
    expect((await guardar({ periodicidadIva: 'TRIMESTRAL' })).status).toBe(403);
    rol = 'contable';
    expect((await guardar({ periodicidadIva: 'TRIMESTRAL' })).status).toBe(200);
    rol = 'admin';
  });

  it('empresa de EE. UU.: 409 en GET y PUT', async () => {
    for (const res of [await leer(US), await guardar({ periodicidadIva: 'MENSUAL' }, US)]) {
      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/no está establecida en España/);
    }
  });

  it('pasar a mensual a mitad de año con el 1T presentado: la vista previa dice desde cuándo y enseña lo real', async () => {
    await listarModelosImpuesto(ES, 2026); // crea el calendario trimestral
    const t1 = await prisma.modeloImpuesto.findFirstOrThrow({ where: { companyId: ES, codigo: '303', ejercicio: 2026, periodo: '1T' } });
    await prisma.modeloImpuesto.update({ where: { id: t1.id }, data: { estado: 'presentado' } });

    // El 10 de abril el 2T ya ha empezado: sin más, el cambio vale desde julio.
    const vista = await previsualizarAjustesFiscales(ES, { periodicidadIva: 'MENSUAL', redeme: true, sii: true }, '2026-04-10');
    expect(vista.aplicadoDesde).toBe('2026-07-01');
    expect(vista.aviso).toMatch(/desde el 01\/07\/2026/);
    const p303 = vista.modelos.filter((m) => m.codigo === '303');
    expect(p303.map((m) => m.periodo)).toEqual(['1T', '2T', '07', '08', '09', '10', '11', '12']);
    expect(p303[0]).toMatchObject({ periodo: '1T', estado: 'presentado' });
    // Nada guardado.
    expect(await prisma.modeloImpuesto.count({ where: { companyId: ES, codigo: '303', ejercicio: 2026 } })).toBe(4);

    // aplicarDesde tiene que ser el inicio de un trimestre del año en curso.
    await expect(guardarAjustesFiscales(ES, 'u-admin', { periodicidadIva: 'MENSUAL', redeme: true, sii: true, aplicarDesde: '2026-05-01' }, '2026-04-10')).rejects.toMatchObject({
      statusCode: 400,
      details: { campo: 'aplicarDesde' },
    });
  });

  it('con aplicarDesde = 1 de abril: desde abril, sin tocar el 1T presentado', async () => {
    const r = await guardarAjustesFiscales(ES, 'u-admin', { periodicidadIva: 'MENSUAL', redeme: true, sii: true, aplicarDesde: '2026-04-01' }, '2026-04-10');
    expect(r.cambiosCalendario.find((c) => c.ejercicio === 2026)).toMatchObject({ aplicadoDesde: '2026-04-01', borradas: 3, creadas: 9, borradasVencidas: 0 });
    expect(r.aviso).toMatch(/desde el 01\/04\/2026/);

    const p303 = (await prisma.modeloImpuesto.findMany({ where: { companyId: ES, codigo: '303', ejercicio: 2026 } })).map((f) => f.periodo).sort();
    expect(p303).toEqual(['04', '05', '06', '07', '08', '09', '10', '11', '1T', '12'].sort());
    // Abrir otra vez el ejercicio no duplica enero, febrero y marzo encima del 1T.
    await listarModelosImpuesto(ES, 2026);
    expect(await prisma.modeloImpuesto.count({ where: { companyId: ES, codigo: '303', ejercicio: 2026 } })).toBe(10);
    // Los anuales siguen (el año no está entero en el régimen nuevo).
    expect(await prisma.modeloImpuesto.count({ where: { companyId: ES, codigo: '390', ejercicio: 2026 } })).toBe(1);

    // La lista de la pantalla es la real: el 1T presentado y de abril en adelante, sin enero a marzo.
    const leido = await obtenerAjustesFiscales(ES, '2026-04-10');
    expect(leido.calendario.modelos.filter((m) => m.codigo === '303').map((m) => m.periodo)).toEqual(['1T', '04', '05', '06', '07', '08', '09', '10', '11', '12']);

    // El detalle de un 303 mensual funciona.
    const mayo = await prisma.modeloImpuesto.findFirstOrThrow({ where: { companyId: ES, codigo: '303', ejercicio: 2026, periodo: '05' } });
    const detalle = await obtenerDetalleModelo(ES, mayo.id);
    expect(detalle.resumen).toMatchObject({ periodoEtiqueta: '2026-05', fechaVencimiento: '2026-06-30' });

    // Carmen ve lo mismo, sin escribir nada.
    const lectura = await calendarioFiscalSoloLectura(ES, '2026-04-10');
    const de2026 = lectura.filter((m) => m.codigo === '303' && m.ejercicio === 2026).map((m) => m.periodo);
    expect(de2026).toHaveLength(10);
    expect(de2026).not.toContain('01');
  });

  it('guardar sin cambiar nada no avisa de un calendario nuevo', async () => {
    const r = await guardarAjustesFiscales(ES, 'u-admin', { periodicidadIva: 'MENSUAL', redeme: true, sii: true }, '2026-04-10');
    expect(r.cambiosCalendario.find((c) => c.ejercicio === 2026)).toMatchObject({ borradas: 0, creadas: 0 });
    expect(r.aviso).toBeNull();
  });

  it('configurar tarde una gran empresa desde enero: quita los vencidos sin presentar y lo avisa', async () => {
    await listarModelosImpuesto(TARDE, 2026); // calendario trimestral por defecto
    const r = await guardarAjustesFiscales(
      TARDE,
      'u-admin',
      { periodicidadIva: 'MENSUAL', sii: true, granEmpresa: true, aplicarDesde: '2026-01-01' },
      '2026-10-07',
    );
    // 303 y 111/115 trimestrales fuera; 1T y 2T ya vencidos el 7 de octubre (el 3T vence el 20).
    expect(r.cambiosCalendario.find((c) => c.ejercicio === 2026)).toMatchObject({ aplicadoDesde: '2026-01-01', borradasVencidas: 6 });
    expect(r.aviso).toMatch(/Se han quitado 6 modelo\(s\) de periodos ya vencidos/);
    expect(await prisma.modeloImpuesto.count({ where: { companyId: TARDE, codigo: '303', ejercicio: 2026 } })).toBe(12);
  });

  it('un año anterior al de los ajustes guardados se crea con los de por defecto', async () => {
    const filas = await listarModelosImpuesto(TARDE, 2024, 'activos', '2024-01-01');
    expect(filas.filter((f) => f.codigo === '303').map((f) => f.periodo)).toEqual(['1T', '2T', '3T', '4T']);
    expect(filas.some((f) => f.codigo === '390')).toBe(true);
  });

  it('un año que se abre después nace entero con los ajustes guardados', async () => {
    const siguiente = anioEspana() + 1; // posterior al año en que se guardaron (hoy)
    await listarModelosImpuesto(ES, siguiente);
    const p303 = await prisma.modeloImpuesto.findMany({ where: { companyId: ES, codigo: '303', ejercicio: siguiente } });
    expect(p303).toHaveLength(12);
  });

  it('autónomo: 130 trimestral de relleno manual y sin 200', async () => {
    const ajustes = await obtenerAjustesFiscales(AUT, '2026-05-01');
    expect(ajustes.autonomo).toBe(true);
    expect(ajustes.calendario.modelos.filter((m) => m.codigo === '130').every((m) => m.rellenoManual)).toBe(true);

    const filas = await listarModelosImpuesto(AUT, 2026, 'activos', '2026-01-01');
    expect(filas.filter((f) => f.codigo === '130').map((f) => f.periodo)).toEqual(['1T', '2T', '3T', '4T']);
    expect(filas.some((f) => f.codigo === '200')).toBe(false);
    const t130 = filas.find((f) => f.codigo === '130')!;
    expect(t130.rellenoManual).toBe(true);
    await expect(autorrellenarModelo(AUT, t130.id)).rejects.toThrow(MENSAJE_130_MANUAL);
    await expect(generarTxtModelo(AUT, t130.id)).rejects.toThrow(/130/);
  });
});
