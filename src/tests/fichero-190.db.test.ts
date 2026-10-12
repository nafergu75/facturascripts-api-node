/**
 * Fichero del 190 sobre BD real con el historial de declaraciones (B3, B4 y B5):
 *  - la persona de contacto y el telefono son los de Datos de la empresa (apartado Contacto)
 *    (sin ellos, 400 que dice donde rellenarlos);
 *  - el numero identificativo (108-120) lo pone una operacion de escritura y el
 *    fichero (GET) solo lo lee: el mismo en todas las descargas, nunca repetido;
 *  - presentado, el fichero es el que se guardo;
 *  - la sustitutiva lleva todos los perceptores y cita la anterior; la
 *    complementaria, solo los elegidos (por defecto, los que no estaban).
 *
 * Necesita MySQL. Los NIF son inventados (con su letra de control).
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import nominasRoutes from '../routes/nominas.routes';
import { errorMiddleware } from '../middleware/error.middleware';
import { prisma } from '../config/database';
import { letraNif } from '../utils/nif';
import { contabilizarNominas, crearNomina } from '../services/nominas.service';
import { crearEmpleado } from '../services/empleados.service';
import { autorrellenarModelo, idVirtual } from '../services/impuestosModulo.service';
import { ficheroModelo190 } from '../services/nominas/fichero190';
import { calcularModelo190 } from '../services/nominas/fiscal';
import { idRegistro190 } from '../services/nominas/modelo190';
import { asignarNumero, cancelarRectificacion, contextoDeclaracion, guardarRegistros } from '../services/declaracionesAeat/declaraciones.service';
import { prepararRectificacionModelo, presentarDeclaracion } from '../services/declaracionesAeat/presentar';

const COMPANY = `fich190-test-${Date.now()}`;
const nif = (n: number) => `${String(n).padStart(8, '0')}${letraNif(n)}`;
const numero = (f: string) => f.slice(107, 120);
const anterior = (f: string) => f.slice(122, 135);
const registros = (f: string) => f.replace(/\r\n$/, '').split('\r\n');

beforeAll(async () => {
  await prisma.company.create({ data: { id: COMPANY, name: 'Fichero 190 SL', fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
  await prisma.legalConfig.create({ data: { companyId: COMPANY, denominacion: 'Fichero 190 SL', nif: 'B12345674' } });
  const e = await crearEmpleado(COMPANY, { nif: nif(60000001), nombre: 'Ana', apellidos: 'Prueba Uno', provincia: '46', anioNacimiento: 1980, situacionFamiliar: 3 });
  await crearNomina(COMPANY, { empleadoId: e.id, ejercicio: 2025, mes: 3, brutoDinerario: 2000, ssTrabajador: 127, irpf: 300, liquido: 1573, ssEmpresa: 600 });
  const b = await crearEmpleado(COMPANY, { nif: nif(60000002), nombre: 'Blas', apellidos: 'Prueba Dos', provincia: '28', anioNacimiento: 1990, situacionFamiliar: 3 });
  await crearNomina(COMPANY, { empleadoId: b.id, ejercicio: 2025, mes: 3, brutoDinerario: 1500, ssTrabajador: 95.25, irpf: 150, liquido: 1254.75, ssEmpresa: 450 });
  await contabilizarNominas(COMPANY, 2025, 3);
});

describe('persona de contacto (B3)', () => {
  it('sin persona de contacto ni telefono en Datos de la empresa: 400 que dice donde rellenarlos', async () => {
    await expect(ficheroModelo190(COMPANY, 2025)).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/persona de contacto.*Datos de la empresa, apartado Contacto/) });
    await prisma.legalConfig.update({ where: { companyId: COMPANY }, data: { personaContacto: 'Contacto Prueba Ana', telefono: '+34 600 000 000' } });
  });
});

describe('numero identificativo del 190 (B5)', () => {
  it('el GET no pone numero: 409; lo pone la operacion de escritura y todas las descargas llevan el mismo', async () => {
    await expect(ficheroModelo190(COMPANY, 2025)).rejects.toMatchObject({ statusCode: 409 });
    expect(await prisma.declaracionAeat.count({ where: { companyId: COMPANY } })).toBe(0);
    const d = await asignarNumero(COMPANY, 'u1', '190', 2025, '0A');
    expect(d).toMatchObject({ numero: '1902025000001', tipo: 'N', estado: 'preparada' });
    // Otra peticion de numero no gasta otro.
    expect((await asignarNumero(COMPANY, 'u1', '190', 2025, '0A')).numero).toBe('1902025000001');
    const a = await ficheroModelo190(COMPANY, 2025);
    const b = await ficheroModelo190(COMPANY, 2025);
    expect([a.numeroDeclaracion, numero(a.contenido), b.numeroDeclaracion]).toEqual(['1902025000001', '1902025000001', '1902025000001']);
    expect(a.avisos).toEqual([expect.stringMatching(/^Número identificativo de esta declaración: 1902025000001/)]);
    // Contacto de Registro Mercantil > Datos en el registro de declarante.
    expect(registros(a.contenido)[0].slice(58, 107)).toBe('600000000' + 'CONTACTO PRUEBA ANA'.padEnd(40));
  });

  it('«Recalcular importes» no cambia el numero', async () => {
    await autorrellenarModelo(COMPANY, idVirtual('190', 2025, '0A'));
    expect((await contextoDeclaracion(COMPANY, '190', 2025, '0A')).numero).toBe('1902025000001');
  });
});

describe('presentado, sustitutiva y complementaria (B4)', () => {
  let presentado = '';

  it('presentado: el fichero es el que se guardo, aunque cambien las nominas', async () => {
    const h = await presentarDeclaracion(COMPANY, 'u1', '190', 2025, '0A', { numero: '1902025000001', fecha: '2026-01-25' });
    expect(h.estado).toBe('presentada');
    expect(h.declaraciones[0]).toMatchObject({ secuencia: 1, tipo: 'N', numero: '1902025000001', numeroRegistros: 2 });
    presentado = (await ficheroModelo190(COMPANY, 2025)).contenido;
    expect(registros(presentado)).toHaveLength(3);
    // Una nomina nueva despues de presentar no cambia lo presentado.
    const c = await crearEmpleado(COMPANY, { nif: nif(60000003), nombre: 'Carla', apellidos: 'Prueba Tres', provincia: '46', anioNacimiento: 1985, situacionFamiliar: 3 });
    await crearNomina(COMPANY, { empleadoId: c.id, ejercicio: 2025, mes: 11, brutoDinerario: 1000, ssTrabajador: 63.5, irpf: 100, liquido: 836.5, ssEmpresa: 300 });
    await contabilizarNominas(COMPANY, 2025, 11);
    expect((await ficheroModelo190(COMPANY, 2025)).contenido).toBe(presentado);
    // Otra vez presentado: 409 (hay que preparar una complementaria o sustitutiva).
    await expect(presentarDeclaracion(COMPANY, 'u1', '190', 2025, '0A', { numero: '1902025000001', fecha: '2026-01-25' })).rejects.toMatchObject({ statusCode: 409 });
  });

  it('presentado: /perceptores enseña los perceptores y el resumen presentados, y cuenta aparte los nuevos', async () => {
    const a = express();
    a.use(express.json());
    a.use((req, _res, next) => {
      req.user = { userId: 'u1', roles: ['contable'], companies: [COMPANY], rolesPorEmpresa: { [COMPANY]: ['contable'] } } as never;
      req.companyId = COMPANY;
      next();
    });
    a.use('/nominas', nominasRoutes);
    a.use(errorMiddleware);
    const r = (await request(a).get('/nominas/190/2025/perceptores')).body.data;
    expect(r.declaracion.congelada).toBe(true);
    expect(r.perceptores.map((p: { nif: string }) => p.nif).sort()).toEqual([nif(60000001), nif(60000002)]);
    expect(r.resumen.map((c: { valor: number }) => c.valor)).toEqual([2, 3500, 450]);
    expect(r.avisoCongelada).toMatch(/1 registro nuevo.*complementaria/);
  });

  it('sustitutiva: numero nuevo, cita la anterior y lleva todos los perceptores; cancelada, su numero no se reutiliza', async () => {
    const h = await prepararRectificacionModelo(COMPANY, 'u1', '190', 2025, '0A', { tipo: 'S' });
    expect(h.enCurso).toMatchObject({ tipo: 'S', numero: '1902025000002', justificanteAnterior: '1902025000001' });
    const s = await ficheroModelo190(COMPANY, 2025);
    expect([numero(s.contenido), anterior(s.contenido), registros(s.contenido)[0].slice(121, 122)]).toEqual(['1902025000002', '1902025000001', 'S']);
    expect(registros(s.contenido)).toHaveLength(4);
    await cancelarRectificacion(COMPANY, 'u1', '190', 2025, '0A');
    // Vuelve a lo presentado.
    expect((await ficheroModelo190(COMPANY, 2025)).contenido).toBe(presentado);
  });

  it('complementaria: por defecto solo el perceptor que no estaba; se puede elegir otro conjunto', async () => {
    const h = await prepararRectificacionModelo(COMPANY, 'u1', '190', 2025, '0A', { tipo: 'C' });
    expect(h.enCurso).toMatchObject({ tipo: 'C', numero: '1902025000003', justificanteAnterior: '1902025000001' });
    const m = await calcularModelo190(COMPANY, 2025);
    const carla = m.perceptores.find((p) => p.nif === nif(60000003))!;
    expect(h.enCurso!.registros).toEqual([idRegistro190(carla)]);
    const c = await ficheroModelo190(COMPANY, 2025);
    const regs = registros(c.contenido);
    expect(regs).toHaveLength(2);
    expect(regs[1].slice(17, 26)).toBe(nif(60000003));
    expect(regs[0].slice(120, 121)).toBe('C');
    expect(regs[0].slice(135, 144)).toBe('000000001');
    expect(regs[0].slice(160, 175)).toBe('000000000010000');
    // Sin ninguno elegido: 400 que explica la complementaria y propone la sustitutiva.
    await guardarRegistros(COMPANY, '190', 2025, '0A', []);
    await expect(ficheroModelo190(COMPANY, 2025)).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/solo van los perceptores que se quedaron fuera.*sustitutiva \(S\)/) });
    await guardarRegistros(COMPANY, '190', 2025, '0A', [idRegistro190(carla)]);
    // Se presenta la complementaria: secuencia 2, con su numero.
    const p = await presentarDeclaracion(COMPANY, 'u1', '190', 2025, '0A', { numero: '1902025000003', fecha: '2026-02-10' });
    expect(p.declaraciones.filter((d) => d.estado === 'presentada').map((d) => [d.secuencia, d.tipo, d.numero])).toEqual([
      [1, 'N', '1902025000001'],
      [3, 'C', '1902025000003'],
    ]);
    expect(p.declaraciones.find((d) => d.secuencia === 2)).toMatchObject({ estado: 'anulada', numero: '1902025000002' });
  });
});

describe('clave G en el calculo del 190', () => {
  it('una sociedad con retencion no entra en el 190 y el aviso dice cual', async () => {
    const prov = await prisma.supplier.create({ data: { companyId: COMPANY, nombreFiscal: 'Consultora Prueba, S.L.', nifCif: 'B46000006', cp: '46001' } });
    await prisma.expenseInvoice.create({
      data: { companyId: COMPANY, supplierId: prov.id, serie: 'P', numero: 1, numeroCompleto: 'P-1', fechaEmision: '2025-05-05', fechaVencimiento: '2025-06-05', estado: 'ACCOUNTED', baseTotal: 600, retencionTotal: 90, tipoRetencion: 15, totalFactura: 636 },
    });
    const m = await calcularModelo190(COMPANY, 2025);
    expect(m.perceptores.some((p) => p.clave === 'G')).toBe(false);
    expect(m.avisos).toContainEqual(expect.stringMatching(/^Se han quitado del 190 este proveedor con NIF de sociedad: Consultora Prueba, S\.L\. \(B46000006\)/));
    // Su retencion sigue en el 111: el cuadre avisa.
    expect(m.cuadre111.coincide).toBe(false);
  });
});
