/**
 * El 390 toma el resultado de cada 303 de lo PRESENTADO (también la
 * rectificativa), no del cálculo de hoy con las facturas; con la empresa que
 * presenta el 303 cada mes, usa los meses y la casilla [85] sale del 303 de
 * enero.
 *
 * Necesita MySQL. Los NIF son inventados (con su carácter de control).
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import { prisma } from '../config/database';
import { borrador390 } from '../services/borradoresAeat.service';
import { prepararRectificacionModelo, presentarDeclaracion } from '../services/declaracionesAeat/presentar';
import { limpiarLegalConfig } from '../services/legalConfig.service';

const T = Date.now();
const TRIM = `aeat390-trim-${T}`;
const MES = `aeat390-mes-${T}`;
const RECT = `aeat390-rect-${T}`;

let numero = 0;
async function venta(companyId: string, customerId: string, fecha: string, base: number) {
  numero += 1;
  const iva = Math.round(base * 21) / 100;
  await prisma.incomeInvoice.create({
    data: {
      companyId,
      customerId,
      serie: 'R',
      numero,
      numeroCompleto: `R-${numero}`,
      fechaEmision: fecha,
      fechaVencimiento: fecha,
      tipoOperacion: 'NACIONAL',
      baseTotal: base,
      ivaTotal: iva,
      totalFactura: base + iva,
      lineas: { create: [{ descripcion: 'Venta', cantidad: 1, precioUnitario: base, baseLine: base, ivaImporte: iva, tipoIva: 21 }] },
    },
  });
}

const clientes: Record<string, string> = {};

beforeAll(async () => {
  for (const id of [TRIM, MES, RECT]) {
    await prisma.company.create({ data: { id, name: `390 ${id}`, fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
    await prisma.legalConfig.create({ data: { companyId: id, denominacion: 'Resumen Anual, S.L.', nif: 'B46000006', telefono: '961234567', personaContacto: 'García Pérez Ana', cnae: '4646' } });
    clientes[id] = (await prisma.customer.create({ data: { companyId: id, nombreFiscal: 'Cliente Turia, S.L.', nifCif: 'B12345674', pais: 'ES', cp: '46001' } })).id;
  }
  await prisma.ajustesFiscales.create({ data: { companyId: MES, periodicidadIva: 'MENSUAL' } });
});

describe('390 con los 303 presentados', () => {
  it('trimestral: el 1T presentado manda aunque después se registre otra factura de ese trimestre', async () => {
    await venta(TRIM, clientes[TRIM], '2026-02-10', 1000); // 210 de IVA
    await venta(TRIM, clientes[TRIM], '2026-05-10', 2000); // 420
    await presentarDeclaracion(TRIM, 'u-390', '303', 2026, '1T', { numero: '3032026000001', fecha: '2026-04-15' });
    await venta(TRIM, clientes[TRIM], '2026-03-15', 500); // 105 que ya no entraron en el 1T presentado

    const b = await borrador390(TRIM, 2026);
    expect(b.liquidaciones.periodos).toEqual(['1T', '2T', '3T', '4T']);
    expect(b.liquidaciones.finales).toEqual([210, 420, 0, 0]);
    expect(b.liquidaciones.casilla95).toBe(630);
    const avisos = b.advertencias.join(' ');
    expect(avisos).toMatch(/Los 303 de 2T, 3T, 4T no están marcados como presentados/);
    // El devengado del año sí incluye la factura nueva: no cuadra con lo presentado y se avisa.
    expect(avisos).toMatch(/\[86\] \(735,00 €\) no cuadra con los 303 del año \(a ingresar 630,00 €/);
  });

  it('un 303 presentado con su rectificativa en preparación cuenta como presentado: el 390 usa lo presentado y lo dice', async () => {
    await venta(RECT, clientes[RECT], '2026-05-10', 1000); // 210 de IVA en el 2T
    await presentarDeclaracion(RECT, 'u-390', '303', 2026, '2T', { numero: '3032026000002', fecha: '2026-07-15' });
    await venta(RECT, clientes[RECT], '2026-06-10', 500); // 105 más: la rectificativa los llevará
    await prepararRectificacionModelo(RECT, 'u-390', '303', 2026, '2T', { tipo: 'C' });
    expect((await prisma.modeloImpuesto.findFirst({ where: { companyId: RECT, codigo: '303', periodo: '2T' } }))?.estado).toBe('vigente');

    const b = await borrador390(RECT, 2026);
    expect(b.liquidaciones.finales).toEqual([0, 210, 0, 0]); // lo presentado, no los 315 de hoy
    const avisos = b.advertencias.join(' ');
    expect(avisos).toMatch(/Los 303 de 1T, 3T, 4T no están marcados como presentados/);
    expect(avisos).toMatch(/El 303 de 2T tiene una rectificativa en preparación: el 390 usa lo presentado/);
  });

  it('mensual: doce meses, el de enero presentado, y [85] con el [110] de enero', async () => {
    await venta(MES, clientes[MES], '2026-01-10', 1000); // 210
    await venta(MES, clientes[MES], '2026-02-10', 100); // 21
    await prisma.modeloImpuesto.create({
      data: {
        companyId: MES,
        codigo: '303',
        ejercicio: 2026,
        periodo: '01',
        estado: 'presentado',
        casillas: { '110_cuotas_compensar_anteriores': 50 } as never,
        datos: { resultado: 210, casillasOficiales: { '46': 210, '69': 160, '78': 50, '110': 50 } } as never,
      },
    });
    const b = await borrador390(MES, 2026);
    expect(b.liquidaciones.periodos).toEqual(['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12']);
    expect(b.liquidaciones.finales.slice(0, 2)).toEqual([160, 21]); // [69] + [78] de enero = 210, menos los 50 del año anterior
    expect(b.liquidaciones.casilla85).toBe(50);
  });

  it('clave de actividad y epígrafe del IAE de Registro Mercantil > Datos en las posiciones 188 y 191', async () => {
    const sin = await borrador390(TRIM, 2026);
    expect(sin.advertencias.join(' ')).toMatch(/clave de actividad o el epígrafe del IAE.*Registro Mercantil/);
    await prisma.legalConfig.update({ where: { companyId: TRIM }, data: limpiarLegalConfig({ claveActividad: 'a03', epigrafeIae: '615.1' }) as never });
    const b = await borrador390(TRIM, 2026);
    const p1 = b.paginas.find((p) => p.codigo === '01000')!.linea;
    expect(p1.slice(187, 194)).toBe('A03' + '6151');
    expect(b.advertencias.join(' ')).not.toMatch(/epígrafe del IAE/);
  });

  it('la clave y el epígrafe se validan al guardarlos', () => {
    expect(() => limpiarLegalConfig({ claveActividad: 'X1' })).toThrow(/letra y dos cifras/);
    expect(() => limpiarLegalConfig({ epigrafeIae: '61511' })).toThrow(/4 cifras/);
    expect(limpiarLegalConfig({ claveActividad: '', epigrafeIae: '' })).toMatchObject({ claveActividad: null, epigrafeIae: null });
  });
});
