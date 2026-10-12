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
import { presentarDeclaracion } from '../services/declaracionesAeat/presentar';

const T = Date.now();
const TRIM = `aeat390-trim-${T}`;
const MES = `aeat390-mes-${T}`;

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
  for (const id of [TRIM, MES]) {
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
    expect(avisos).toMatch(/\[86\] \(735\.00 €\) no cuadra con los 303 del año \(a ingresar 630\.00 €/);
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
});
