/**
 * VERI*FACTU F1 con las plantillas de factura A (envases e IEEPNR) y B
 * (ceramica), sobre BD real. Las dos ramas se hicieron por separado; aqui se
 * comprueba que juntas dan un registro correcto:
 *
 *  - NZ004_26 (A): el IEEPNR va DENTRO de la base del desglose y la cuota es
 *    la del tipo (1.502,05, no la suma linea a linea de 1.502,04): base
 *    7.152,63, cuota 1.502,05 e importe total 8.654,68. Su rectificativa
 *    total, en negativo, y una por diferencias que solo corrige kg.
 *  - NZ013_2026 (B): el cargo de palets es una linea mas del desglose (base
 *    600,74 con los 9,00 del palet, cuota 126,16 y total 726,90).
 *  - El PDF de una A o una B emitida conserva la linea del Registro Mercantil
 *    de cuando se emitio (instantanea), aunque despues cambien los datos.
 *  - Una simplificada registrada con la A o la B sale solo con el nombre del
 *    cliente, como con la plantilla de siempre.
 *
 * Pasa tambien con connection_limit=1 (como en produccion).
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import { prisma } from '../config/database';
import { incomeInvoicesService, type CrearFacturaIngresoDTO, type CrearLineaIngresoDTO } from '../services/income-invoices.service';
import { guardarAjustesFacturacion } from '../services/ajustesFacturacion.service';
import { crearSerie, listarSeries } from '../services/series.service';
import { asegurarPlanContableEmpresa } from '../services/chart-of-accounts.service';
import { comprobarCadena } from '../services/verifactu/cadena';
import { cadenaAlta, huella } from '../services/verifactu/huella';
import type { RegistroContenido } from '../services/verifactu/tipos';
import { datosPdfFactura, generarPdfFactura } from '../services/facturaPdf.service';
import { textoRegistroA } from '../services/facturaPdfPlantillaA';
import { LINEAS_NZ004, TOTALES_NZ004 } from './muestra-nz004';
import { LINEAS_NZ013, TOTALES_NZ013 } from './muestra-nz013';
import { textosDePdf } from './texto-pdf';

const SUFIJO = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const E = `vf-plantillas-${SUFIJO}`;
const NIF_CLIENTE = 'B12345674';
let cliente = '';

/** CIF de sociedad limitada valido y distinto en cada ejecucion (el del cliente es otro). */
function cifSl(): string {
  const d = String(1_000_000 + Math.floor(Math.random() * 8_999_999)).split('').map(Number);
  let suma = 0;
  d.forEach((n, i) => {
    if (i % 2 === 0) suma += Math.floor((n * 2) / 10) + ((n * 2) % 10);
    else suma += n;
  });
  return `B${d.join('')}${(10 - (suma % 10)) % 10}`;
}
const NIF_E = cifSl();

const lineasA = (signo = 1): CrearLineaIngresoDTO[] =>
  LINEAS_NZ004.map((l) => ({
    descripcion: l.descripcion,
    textoAdicional: l.textoAdicional,
    packs: signo * l.packs,
    cantidad: signo * l.cantidad,
    kgPlastico: signo * l.kgPlastico,
    precioUnitario: l.precioUnitario,
    tipoIva: 21,
  }));

const lineasB = (): CrearLineaIngresoDTO[] =>
  LINEAS_NZ013.map((l) => ({
    descripcion: l.descripcion,
    textoAdicional: l.textoAdicional,
    cantidad: l.cantidad,
    precioUnitario: l.precioUnitario,
    tipoIva: 21,
    ...(l.cargoPalets
      ? { cargoPalets: true }
      : { palets: l.palets, cajas: l.cajas, metros2: l.metros2, piezas: l.piezas, formato: l.formato, calidad: l.calidad, unidadPrecio: l.unidadPrecio }),
  }));

const emitir = (extra: Record<string, unknown>) =>
  incomeInvoicesService.crearIngreso({ companyId: E, customer: { id: cliente }, fechaEmision: '2026-07-10', ...extra } as unknown as CrearFacturaIngresoDTO);

const rect = (originalId: string, lineas: CrearLineaIngresoDTO[]) =>
  incomeInvoicesService.crearIngreso({
    companyId: E,
    customer: {},
    lineas,
    rectificativa: { ticket: false, forma: 'I', motivo: 'DEVOLUCION', explicacion: 'Devuelven la mercancía', originales: [{ id: originalId }] },
  } as unknown as CrearFacturaIngresoDTO);

async function registroDe(incomeInvoiceId: string) {
  const rs = await prisma.verifactuRegistro.findMany({ where: { incomeInvoiceId } });
  expect(rs).toHaveLength(1);
  return rs[0];
}
const contenido = (r: { contenido: unknown }) => r.contenido as unknown as RegistroContenido;

beforeAll(async () => {
  await prisma.company.create({ data: { id: E, name: 'Envases y Ceramica Prueba SL', fsBaseUrl: 'http://localhost:8080', fsApiKeyEnc: 'k' } });
  await prisma.legalConfig.create({
    data: {
      companyId: E,
      tipoSociedad: 'SL',
      denominacion: 'ENVASES Y CERAMICA PRUEBA SL',
      nif: NIF_E,
      municipio: 'Valencia',
      datosRegistrales: 'T 1, F 2, H CS 3',
      registroMercantilProvincia: 'Castellón',
    },
  });
  await asegurarPlanContableEmpresa(E);
  cliente = (
    await prisma.customer.create({
      data: { companyId: E, nombreFiscal: 'CLIENTE FICTICIO BEBIDAS SL', nifCif: NIF_CLIENTE, pais: 'ES', direccion: 'CALLE FALSA, 1', cp: '46000', municipio: 'VALENCIA' },
    })
  ).id;
  await listarSeries(E);
  await crearSerie(E, { codigo: 'B', descripcion: 'Ceramica y materiales', tipoDocumento: 'FACTURA', activa: true, porDefecto: false });
  // Repercute el IEEPNR (la serie A usa sola la A), vende ceramica (la B usa sola la B) y los palets van a la 704.
  await guardarAjustesFacturacion(E, 'u-test', { ieepnrRepercute: true, vendeCeramica: true, cuentaPalets: '704' });
  await prisma.verifactuConfig.create({ data: { companyId: E, estado: 'PRUEBAS', entorno: 'PRUEBAS' } });
});

describe('plantilla A (NZ004_26): el IEEPNR dentro de la base del desglose', () => {
  let originalId = '';

  it('emitida: un solo grupo al 21 % con base 7.152,63, cuota por tipo 1.502,05 y total 8.654,68', async () => {
    const f = await emitir({ serie: 'A', lineas: lineasA(), pesoBrutoKg: TOTALES_NZ004.pesoBrutoKg });
    originalId = f.id;
    expect([f.plantillaId, f.baseTotal, f.ivaTotal, f.totalFactura]).toEqual(['A', TOTALES_NZ004.base, TOTALES_NZ004.iva, TOTALES_NZ004.total]);
    const r = await registroDe(f.id);
    expect(r).toMatchObject({ tipoFactura: 'F1', numSerie: f.numeroCompleto, idEmisor: NIF_E, cuotaTotal: '1502.05', importeTotal: '8654.68', entorno: 'PRUEBAS' });
    const c = contenido(r);
    expect(c.desglose).toEqual([
      { impuesto: '01', claveRegimen: '01', calificacionOperacion: 'S1', tipoImpositivo: '21.00', baseImponible: '7152.63', cuotaRepercutida: '1502.05' },
    ]);
    // La base del registro lleva los 177,75 del IEEPNR sobre los 6.974,88 de los articulos.
    expect(Math.round(TOTALES_NZ004.articulos * 100) + Math.round(TOTALES_NZ004.ieepnr * 100)).toBe(715263);
    expect(c.destinatarios).toEqual([{ nombre: 'CLIENTE FICTICIO BEBIDAS SL', nif: NIF_CLIENTE }]);
    // La huella se recalcula con los textos guardados.
    expect(r.huella).toBe(
      huella(
        cadenaAlta({
          idEmisor: r.idEmisor,
          numSerie: r.numSerie,
          fecha: r.fechaExpedicion,
          tipoFactura: r.tipoFactura!,
          cuotaTotal: r.cuotaTotal!,
          importeTotal: r.importeTotal!,
          huellaAnterior: r.huellaAnterior ?? '',
          fechaHoraHuso: r.fechaHoraHuso,
        }),
      ),
    );
    const fila = await prisma.incomeInvoice.findUniqueOrThrow({ where: { id: f.id } });
    expect(fila.verifactuEstado).toBe('PENDIENTE');
  });

  it('rectificativa total (espejo): el mismo desglose en negativo, con la factura rectificada y su fecha de operación', async () => {
    const r = await rect(originalId, lineasA(-1));
    expect([r.plantillaId, r.baseTotal, r.ivaTotal]).toEqual(['A', -TOTALES_NZ004.base, -TOTALES_NZ004.iva]);
    const reg = await registroDe(r.id);
    expect(reg).toMatchObject({ tipoFactura: 'R1', cuotaTotal: '-1502.05', importeTotal: '-8654.68' });
    const c = contenido(reg);
    expect([c.tipoRectificativa, c.fechaOperacion]).toEqual(['I', '10-07-2026']);
    expect(c.desglose).toEqual([
      { impuesto: '01', claveRegimen: '01', calificacionOperacion: 'S1', tipoImpositivo: '21.00', baseImponible: '-7152.63', cuotaRepercutida: '-1502.05' },
    ]);
    const original = await prisma.incomeInvoice.findUniqueOrThrow({ where: { id: originalId } });
    expect(c.facturasRectificadas).toEqual([{ idEmisor: NIF_E, numSerie: original.numeroCompleto, fecha: '10-07-2026' }]);
  });

  it('rectificativa por diferencias que solo corrige kg: la base del registro es el IEEPNR de esos kg', async () => {
    const o = await emitir({ serie: 'A', lineas: lineasA().slice(0, 1) });
    // 0 unidades y -10 kg de plastico: -4,50 € de IEEPNR, con su IVA.
    const r = await rect(o.id, [{ ...lineasA()[0], packs: 0, cantidad: 0, kgPlastico: -10 }]);
    expect([r.baseTotal, r.ivaTotal]).toEqual([-4.5, -0.95]);
    const c = contenido(await registroDe(r.id));
    expect(c.desglose).toEqual([{ impuesto: '01', claveRegimen: '01', calificacionOperacion: 'S1', tipoImpositivo: '21.00', baseImponible: '-4.50', cuotaRepercutida: '-0.95' }]);
  });
});

describe('plantilla B (NZ013_2026): el cargo de palets dentro del desglose', () => {
  it('emitida en la serie B: base 600,74 con los 9,00 del palet, cuota 126,16 y total 726,90', async () => {
    const f = await emitir({ serie: 'B', lineas: lineasB(), pesoNetoKg: TOTALES_NZ013.pesoNetoKg, pesoBrutoKg: TOTALES_NZ013.pesoBrutoKg });
    expect([f.plantillaId, f.baseTotal, f.ivaTotal, f.totalFactura]).toEqual(['B', TOTALES_NZ013.base, TOTALES_NZ013.iva, TOTALES_NZ013.total]);
    expect(f.lineas.filter((l) => l.cargoPalets).map((l) => l.baseLine)).toEqual([9]);
    const r = await registroDe(f.id);
    expect(r).toMatchObject({ tipoFactura: 'F1', cuotaTotal: '126.16', importeTotal: '726.90' });
    expect(contenido(r).desglose).toEqual([
      { impuesto: '01', claveRegimen: '01', calificacionOperacion: 'S1', tipoImpositivo: '21.00', baseImponible: '600.74', cuotaRepercutida: '126.16' },
    ]);
  });

  it('la cadena de la empresa sigue bien encadenada con las A, las B y sus rectificativas', async () => {
    const cadena = await prisma.verifactuRegistro.findMany({ where: { companyId: E, entorno: 'PRUEBAS' }, orderBy: { numeroEnCadena: 'asc' } });
    expect(cadena.length).toBeGreaterThanOrEqual(5);
    expect(comprobarCadena(cadena)).toEqual([]);
  });
});

describe('PDF de una A o una B emitida', () => {
  it('la línea del Registro Mercantil es la de la emisión, aunque después cambien los datos de la empresa', async () => {
    const a = await emitir({ serie: 'A', lineas: lineasA().slice(0, 2) });
    const b = await emitir({ serie: 'B', lineas: lineasB() });
    await prisma.legalConfig.update({ where: { companyId: E }, data: { datosRegistrales: 'T 9, F 9, H V 9', registroMercantilProvincia: 'Valencia' } });
    try {
      for (const id of [a.id, b.id]) {
        const { datos } = await datosPdfFactura(E, id);
        expect(datos.emisor).toMatchObject({ datosRegistrales: 'T 1, F 2, H CS 3', registroMercantilProvincia: 'Castellón' });
        expect(textoRegistroA(datos.emisor, NIF_E)).toBe(`Inscrita en el Registro Mercantil de Castellón, T 1, F 2, H CS 3, con CIF: ${NIF_E}`);
      }
      // Un borrador usa los de ahora.
      const borrador = await emitir({ serie: 'A', lineas: lineasA().slice(0, 1), borrador: true });
      expect((await datosPdfFactura(E, borrador.id)).datos.emisor).toMatchObject({ datosRegistrales: 'T 9, F 9, H V 9', registroMercantilProvincia: 'Valencia' });
    } finally {
      await prisma.legalConfig.update({ where: { companyId: E }, data: { datosRegistrales: 'T 1, F 2, H CS 3', registroMercantilProvincia: 'Castellón' } });
    }
  });

  it('una simplificada registrada con la A o la B solo lleva el nombre del cliente; una completa, también su NIF', async () => {
    const lineaA = { ...lineasA()[0], packs: 10, cantidad: 40, kgPlastico: 1.342 };
    const lineaB = lineasB()[0];
    for (const [serie, lineas] of [
      ['A', [lineaA]],
      ['B', [lineaB]],
    ] as const) {
      const f2 = await emitir({ serie, tipoFactura: 'F2', lineas });
      const reg = await registroDe(f2.id);
      expect([f2.plantillaId, reg.tipoFactura, contenido(reg).destinatarios]).toEqual([serie, 'F2', undefined]);
      const { datos } = await datosPdfFactura(E, f2.id);
      expect(datos.clienteSinIdentificar).toBe(true);
      const textos = (await textosDePdf((await generarPdfFactura(E, f2.id)).contenido)).map((t) => t.texto).join('\n');
      expect(textos).toContain('CLIENTE FICTICIO BEBIDAS SL');
      expect(textos).not.toContain(NIF_CLIENTE);
      expect(textos).not.toContain('CALLE FALSA');

      const f1 = await emitir({ serie, lineas });
      const textosF1 = (await textosDePdf((await generarPdfFactura(E, f1.id)).contenido)).map((t) => t.texto).join('\n');
      expect(textosF1).toContain(NIF_CLIENTE);
      expect(textosF1).toContain('CALLE FALSA');
    }
  });
});
