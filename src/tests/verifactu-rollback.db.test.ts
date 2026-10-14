/**
 * VERI*FACTU F1: si el registro de alta no se puede generar, no se emite la
 * factura (spec verifactu, 3.2 y 12.2). Todo va en la misma transaccion: ni
 * numero gastado, ni registro, ni cabeza de la cadena movida, ni factura FINAL.
 *
 * Necesita MySQL.
 */
import { describe, it, expect, beforeAll, afterEach } from '@jest/globals';
import { randomBytes } from 'crypto';
import { prisma } from '../config/database';
import { marcarEmpresaPruebas } from './ayuda-empresa-pruebas';
import { incomeInvoicesService, type CrearFacturaIngresoDTO } from '../services/income-invoices.service';
import { listarSeries } from '../services/series.service';
import * as cadenaMod from '../services/verifactu/cadena';
import * as registroMod from '../services/verifactu/registro.service';
import { hoyEspana } from '../utils/fechas';

const SUFIJO = `${Date.now()}${randomBytes(3).toString('hex')}`;
const E = `vfrb-${SUFIJO}`;
const LARGA = `vfrb-larga-${SUFIJO}`;
const HOY = hoyEspana();
const clientes: Record<string, { conNif: string; sinNif: string }> = {};

function cifSl(): string {
  const d = String(1_000_000 + Math.floor(Math.random() * 8_999_999)).split('').map(Number);
  let suma = 0;
  d.forEach((n, i) => {
    if (i % 2 === 0) suma += Math.floor((n * 2) / 10) + ((n * 2) % 10);
    else suma += n;
  });
  return `B${d.join('')}${(10 - (suma % 10)) % 10}`;
}

const linea = (precio = 100) => ({ descripcion: 'Servicio', cantidad: 1, precioUnitario: precio, tipoIva: 21 });
const emitir = (companyId: string, cliente: string, extra: Record<string, unknown> = {}) =>
  incomeInvoicesService.crearIngreso({ companyId, customer: { id: cliente }, fechaEmision: HOY, lineas: [linea()], ...extra } as CrearFacturaIngresoDTO);

/** Lo que no puede cambiar si una emision falla. */
async function estado(companyId: string) {
  return {
    ultimoNumero: (await prisma.invoiceSeries.findUniqueOrThrow({ where: { companyId_codigo: { companyId, codigo: 'A' } } })).ultimoNumero,
    finales: await prisma.incomeInvoice.count({ where: { companyId, estadoDocumento: 'FINAL' } }),
    registros: await prisma.verifactuRegistro.count({ where: { companyId } }),
    cabeza: await prisma.verifactuCadena.findUnique({ where: { companyId_entorno: { companyId, entorno: 'PRUEBAS' } } }),
  };
}

beforeAll(async () => {
  for (const id of [E, LARGA]) {
    await prisma.company.create({ data: { id, name: `Rollback ${id}`, fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
    await prisma.legalConfig.create({
      data: { companyId: id, tipoSociedad: 'SL', nif: cifSl(), denominacion: id === LARGA ? `Denominación muy larga ${'x'.repeat(130)} SL` : 'Rollback SL' },
    });
    await listarSeries(id);
    await prisma.verifactuConfig.create({ data: { companyId: id, estado: 'PRUEBAS', entorno: 'PRUEBAS' } });
    await marcarEmpresaPruebas(prisma, id);
    clientes[id] = {
      conNif: (await prisma.customer.create({ data: { companyId: id, nombreFiscal: 'Cliente SL', nifCif: 'B12345674', pais: 'ES' } })).id,
      sinNif: (await prisma.customer.create({ data: { companyId: id, nombreFiscal: 'Sin NIF', nifCif: '', pais: 'ES' } })).id,
    };
  }
  // Un primer registro, para que la cabeza de la cadena ya tenga huella.
  await emitir(E, clientes[E].conNif);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('validarAlta falla dentro de la transacción', () => {
  it('finalizar: 422, el borrador sigue sin número y la serie y la cadena como estaban', async () => {
    // Sin la comprobacion previa (como si el cliente hubiera cambiado entre medias): manda la de dentro.
    const b = await emitir(E, clientes[E].sinNif, { borrador: true });
    const antes = await estado(E);
    jest.spyOn(registroMod, 'planRegistro').mockResolvedValue(null);
    await expect(incomeInvoicesService.finalizar(E, b.id, { fechaEmision: HOY })).rejects.toMatchObject({
      statusCode: 422,
      details: { codigo: 'VERIFACTU_CLIENTE_SIN_NIF' },
    });
    expect(await prisma.incomeInvoice.findUniqueOrThrow({ where: { id: b.id } })).toMatchObject({ estadoDocumento: 'BORRADOR', numero: null, numeroCompleto: null, instantaneaEmision: null });
    expect(await estado(E)).toEqual(antes);
  });

  it('emisión directa: 422 y no se crea la factura', async () => {
    const antes = await estado(E);
    const facturas = await prisma.incomeInvoice.count({ where: { companyId: E } });
    jest.spyOn(registroMod, 'planRegistro').mockResolvedValue(null);
    await expect(emitir(E, clientes[E].sinNif)).rejects.toMatchObject({ statusCode: 422, details: { codigo: 'VERIFACTU_CLIENTE_SIN_NIF' } });
    expect(await prisma.incomeInvoice.count({ where: { companyId: E } })).toBe(facturas);
    expect(await estado(E)).toEqual(antes);
  });

  it('una denominación de más de 120 caracteres (solo la ve la validación de dentro): 422 y nada', async () => {
    // La fila de la cadena se crea fuera de la transaccion (planRegistro), antes de emitir: es lo esperado.
    await registroMod.planRegistro(LARGA);
    const antes = await estado(LARGA);
    await expect(emitir(LARGA, clientes[LARGA].conNif)).rejects.toMatchObject({ statusCode: 422, details: { codigo: 'VERIFACTU_NOMBRE_EMISOR' } });
    expect(await estado(LARGA)).toEqual(antes);
    // Tampoco se congela nada en la configuracion.
    expect(await prisma.verifactuConfig.findUniqueOrThrow({ where: { companyId: LARGA } })).toMatchObject({ nifObligado: null, nombreObligado: null, numeroInstalacion: null });
  });
});

describe('fallo después de crear el registro', () => {
  it('emisión directa: ni número, ni registro, ni cabeza cambiada, ni factura emitida', async () => {
    const antes = await estado(E);
    jest.spyOn(cadenaMod, 'avanzarCadena').mockRejectedValueOnce(new Error('fallo simulado al avanzar la cadena'));
    await expect(emitir(E, clientes[E].conNif)).rejects.toThrow(/fallo simulado/);
    expect(await estado(E)).toEqual(antes);
  });

  it('finalizar: el borrador sigue siendo borrador', async () => {
    const b = await emitir(E, clientes[E].conNif, { borrador: true });
    const antes = await estado(E);
    jest.spyOn(cadenaMod, 'avanzarCadena').mockRejectedValueOnce(new Error('fallo simulado al avanzar la cadena'));
    await expect(incomeInvoicesService.finalizar(E, b.id, { fechaEmision: HOY })).rejects.toThrow(/fallo simulado/);
    expect(await prisma.incomeInvoice.findUniqueOrThrow({ where: { id: b.id } })).toMatchObject({ estadoDocumento: 'BORRADOR', numero: null });
    expect(await estado(E)).toEqual(antes);
    // Despues se emite bien y la cadena sigue donde estaba.
    const f = await incomeInvoicesService.finalizar(E, b.id, { fechaEmision: HOY });
    const r = await prisma.verifactuRegistro.findFirstOrThrow({ where: { incomeInvoiceId: f.id } });
    expect(r).toMatchObject({ numeroEnCadena: antes.registros + 1, registroAnteriorId: antes.cabeza!.ultimoRegistroId, huellaAnterior: antes.cabeza!.ultimaHuella });
  });
});
