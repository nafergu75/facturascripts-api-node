/**
 * Fichero del 190 sobre BD real: el numero identificativo (108-120) lo pone la
 * app, se guarda en la fila del 190 (ModeloImpuesto, datos.numeracion190), no
 * se repite en la empresa y el ejercicio y sobrevive a los recalculos.
 *
 * Necesita MySQL. Los NIF son inventados (con su letra de control).
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import { prisma } from '../config/database';
import { letraNif } from '../utils/nif';
import { contabilizarNominas, crearNomina } from '../services/nominas.service';
import { crearEmpleado } from '../services/empleados.service';
import { autorrellenarModelo } from '../services/impuestosModulo.service';
import { taxModelsService } from '../services/tax-models.service';
import { ficheroModelo190 } from '../services/nominas/fichero190';
import { estadoNumeracion190, numeracionDeDatos } from '../services/nominas/numeracion190';

const COMPANY = `fich190-test-${Date.now()}`;
const nif = (n: number) => `${String(n).padStart(8, '0')}${letraNif(n)}`;
const contacto = { telefono: '600000000', contacto: 'Contacto Prueba' };
const numero = (f: string) => f.slice(107, 120);
const anterior = (f: string) => f.slice(122, 135);

beforeAll(async () => {
  await prisma.company.create({ data: { id: COMPANY, name: 'Fichero 190 SL', fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
  await prisma.legalConfig.create({ data: { companyId: COMPANY, denominacion: 'Fichero 190 SL', nif: 'B12345674' } });
  const e = await crearEmpleado(COMPANY, { nif: nif(60000001), nombre: 'Ana', apellidos: 'Prueba Uno', provincia: '46', anioNacimiento: 1980, situacionFamiliar: 3 });
  await crearNomina(COMPANY, { empleadoId: e.id, ejercicio: 2025, mes: 3, brutoDinerario: 2000, ssTrabajador: 127, irpf: 300, liquido: 1573, ssEmpresa: 600 });
  await contabilizarNominas(COMPANY, 2025, 3);
});

describe('numero identificativo del 190', () => {
  it('lo pone la app; la misma declaracion sin presentar repite numero y se guarda en la fila del 190', async () => {
    const a = await ficheroModelo190(COMPANY, 2025, contacto);
    expect(a.numeroDeclaracion).toBe('1902025000001');
    expect(numero(a.contenido)).toBe('1902025000001');
    expect(a.avisos).toEqual([expect.stringMatching(/^Número identificativo de esta declaración: 1902025000001/)]);
    const b = await ficheroModelo190(COMPANY, 2025, contacto);
    expect(b.numeroDeclaracion).toBe('1902025000001');
    const fila = await prisma.modeloImpuesto.findUniqueOrThrow({ where: { companyId_codigo_ejercicio_periodo: { companyId: COMPANY, codigo: '190', ejercicio: 2025, periodo: '0A' } } });
    expect(numeracionDeDatos(fila.datos).emitidos.map((e) => e.numero)).toEqual(['1902025000001']);
  });

  it('los recalculos del 190 (pantalla y modulo Impuestos) no borran los numeros usados', async () => {
    const pantalla = await taxModelsService.generarModelo190(COMPANY, 2025);
    await autorrellenarModelo(COMPANY, pantalla.id);
    expect((await estadoNumeracion190(COMPANY, 2025)).ultimo?.numero).toBe('1902025000001');
  });

  it('presentado el 190, otra descarga lleva numero nuevo; la sustitutiva cita el anterior y nunca coincide con el', async () => {
    await taxModelsService.marcarPresentado(COMPANY, '190', 2025, '0A', { numero: '1902025000001', fecha: '2026-01-25' }, 'u1');
    expect(await estadoNumeracion190(COMPANY, 2025)).toMatchObject({ presentado: true, justificantePresentado: '1902025000001' });
    const s = await ficheroModelo190(COMPANY, 2025, { ...contacto, tipoDeclaracion: 'S', numeroAnterior: '1902025000001' });
    expect(s.numeroDeclaracion).toBe('1902025000002');
    expect(anterior(s.contenido)).toBe('1902025000001');
    // Si el justificante anterior es el que tocaba (el 3), se salta.
    const s2 = await ficheroModelo190(COMPANY, 2025, { ...contacto, tipoDeclaracion: 'S', numeroAnterior: '1902025000003' });
    expect(s2.numeroDeclaracion).toBe('1902025000004');
    expect(new Set([s.numeroDeclaracion, s2.numeroDeclaracion, '1902025000001']).size).toBe(3);
  });

  it('sin el numero de la anterior, 400 y no se gasta numero', async () => {
    await expect(ficheroModelo190(COMPANY, 2025, { ...contacto, tipoDeclaracion: 'S' })).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/número de la declaración anterior/) });
    expect((await estadoNumeracion190(COMPANY, 2025)).ultimo?.numero).toBe('1902025000004');
  });
});
