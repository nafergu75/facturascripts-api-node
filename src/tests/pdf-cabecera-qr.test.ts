/**
 * Cabecera con el QR de VERI*FACTU en las plantillas A y B (decision del
 * usuario del 15-10), sin BD y con datos ficticios:
 *  - con QR, todo arriba: logo(s) y empresa a la izquierda, el QR en el centro
 *    y el CLIENTE a la derecha; en la A ya no sale el CLIENTE de ancho completo;
 *  - el QR dentro de la cabecera, entre los recuadros, sin que ningun recuadro,
 *    fondo, logo o texto pise su bloque;
 *  - la A con los 7 articulos de NZ004_26 cabe en una pagina, con sus cifras;
 *    la B, con las de NZ013_26;
 *  - sin QR, el dibujo es EXACTAMENTE el de origin/main (huella del contenido);
 *  - un cliente de fuera con el nombre y la direccion largos se parte dentro de
 *    su recuadro sin solaparse con nada; los logos no se deforman;
 *  - textos largos con el QR: el email de la A en dos lineas, el numero de la B
 *    dentro de su recuadro y el nombre de la empresa de las paginas siguientes
 *    sin llegar al titulo.
 */
import { createHash } from 'crypto';
import { describe, it, expect, beforeAll } from '@jest/globals';
import type { PDFFont } from 'pdf-lib';
import { partirAchicando, renderizarFactura, type DatosFacturaPdf } from '../services/facturaPdf.service';
import { CLIENTE_QR_A, EMPRESA_A, HUECO_QR_A, TAM_QR_A } from '../services/facturaPdfPlantillaA';
import { CLIENTE_QR_B, HUECO_QR_B, LOGOS_QR_B, logosCabeceraQrB, TAM_QR_B } from '../services/facturaPdfPlantillaB';
import { ANCHO_BLOQUE_QR, calcularBloqueQr, LEYENDA_QR, MARCA_PRUEBAS, TITULO_QR, type Caja, type CajasBloqueQr } from '../services/verifactu/qrPdf';
import { urlCotejo } from '../services/verifactu/qr';
import { crearDocumentoPdfA } from '../utils/pdf-a';
import { contenidoNormalizado, figurasDePdf, textosDePdf, type TextoPdf } from './texto-pdf';
import { clienteLargoPdfQr, comunPdfQr, logosPdfQr, plantillaAPdfQr, plantillaBPdfQr, pngLiso, rectificativaPdfQr } from './datos-pdf-qr';

jest.setTimeout(120_000);

const ALTO = 841.89;
const URL_PRO = urlCotejo({ entorno: 'PRODUCCION', idEmisor: 'B12345674', numSerie: 'A-1', fechaExpedicion: '04-03-2026', importeTotal: '8654.68' });
const URL_PRU = urlCotejo({ entorno: 'PRUEBAS', idEmisor: 'B12345674', numSerie: 'PRU261015-1', fechaExpedicion: '04-03-2026', importeTotal: '8654.68' });
const conPro = { verifactu: { url: URL_PRO, entorno: 'PRODUCCION' as const } };
const conPru = { verifactu: { url: URL_PRU, entorno: 'PRUEBAS' as const }, empresaPruebas: true, numeroCompleto: 'PRU261015-1' };

let fuentes: { normal: PDFFont; negrita: PDFFont };
beforeAll(async () => {
  const d = await crearDocumentoPdfA('medidas');
  fuentes = { normal: d.normal, negrita: d.negrita };
});

/** El bloque del QR de cada plantilla: centrado en su hueco, como lo pone la plantilla. */
const bloqueEn = (hueco: { izq: number; der: number; arriba: number }, tam: number): CajasBloqueQr =>
  calcularBloqueQr({ ...fuentes, xCentro: (hueco.izq + hueco.der) / 2, yArriba: ALTO - hueco.arriba, tam, anchoMax: Math.min(ANCHO_BLOQUE_QR, hueco.der - hueco.izq - 4) });
const bloqueA = () => bloqueEn(HUECO_QR_A, TAM_QR_A);
const bloqueB = () => bloqueEn(HUECO_QR_B, TAM_QR_B);

const TOL = 0.01;
const cortan = (a: Caja, b: Caja) => a.x < b.x + b.ancho - TOL && a.x + a.ancho > b.x + TOL && a.y < b.y + b.alto - TOL && a.y + a.alto > b.y + TOL;
const dentro = (a: Caja, b: Caja) => a.x >= b.x - TOL && a.x + a.ancho <= b.x + b.ancho + TOL && a.y >= b.y - TOL && a.y + a.alto <= b.y + b.alto + TOL;
/** Caja aproximada de un texto: de su base menos el descendente a la altura de las mayusculas (la cursiva se inclina hasta 0,2 de la letra). */
const cajaTexto = (t: TextoPdf): Caja => ({ x: t.x, y: t.y - 0.25 * t.tam, ancho: t.derecha - t.x + 0.2 * t.tam, alto: t.tam });
const esDelQr = (t: TextoPdf) => t.texto === TITULO_QR || LEYENDA_QR.includes(t.texto);
const esMarca = (t: TextoPdf) => t.texto === MARCA_PRUEBAS || t.texto === 'BORRADOR';

/** Comprueba que en la primera pagina nada mas que el QR esta en su bloque: ni rectangulos (bordes y fondos), ni imagenes, ni textos. */
async function nadaPisaElQr(pdf: Buffer, b: CajasBloqueQr) {
  const { rectangulos, imagenes } = await figurasDePdf(pdf);
  const enBloque = rectangulos.filter((r) => r.pagina === 1 && cortan(r, b.cajaBloque));
  // El fondo blanco de la zona en blanco y los modulos negros del QR, nada mas.
  const ajenos = enBloque.filter((r) => {
    const blanco = r.color.every((c) => c === 1);
    const negro = r.color.every((c) => c === 0);
    return !(blanco && dentro(r, b.cajaBlanca)) && !(negro && dentro(r, b.cajaQr));
  });
  expect(ajenos).toEqual([]);
  expect(enBloque.filter((r) => r.color.every((c) => c === 0)).length).toBeGreaterThan(50);
  expect(imagenes.filter((i) => i.pagina === 1 && cortan(i, b.cajaBloque))).toEqual([]);
  const ts = await textosDePdf(pdf);
  expect(ts.filter((t) => t.pagina === 1 && !esDelQr(t) && !esMarca(t) && cortan(cajaTexto(t), b.cajaBloque)).map((t) => t.texto)).toEqual([]);
  // Un solo «QR tributario:», en la primera pagina.
  expect(ts.filter((t) => t.texto === TITULO_QR).map((t) => t.pagina)).toEqual([1]);
}

/** Ningun texto de `ts` se solapa con otro. */
function sinSolapes(ts: TextoPdf[]) {
  const choques: string[] = [];
  ts.forEach((a, i) => ts.slice(i + 1).forEach((z) => cortan(cajaTexto(a), cajaTexto(z)) && choques.push(`${a.texto} / ${z.texto}`)));
  expect(choques).toEqual([]);
}

/** Las lineas en que sale partido `completo` (de arriba abajo); comprueba que juntas (con `union` entre ellas) lo dicen entero. */
const partidoEn = (ts: TextoPdf[], completo: string, union = ' ') => {
  const ls = ts.filter((t) => t.texto.length > 3 && completo.includes(t.texto)).sort((a, z) => z.y - a.y);
  expect(ls.map((t) => t.texto).join(union)).toBe(completo);
  return ls;
};

const unico = (ts: TextoPdf[], s: string) => {
  const t = ts.filter((x) => x.texto === s);
  expect(t).toHaveLength(1);
  return t[0];
};

/** Empresa con el nombre y el domicilio largos (inventados). */
const emisorLargo = {
  ...comunPdfQr.emisor,
  denominacion: 'DISTRIBUCIONES Y MATERIALES DE CONSTRUCCION DEL MEDITERRANEO SOCIEDAD LIMITADA',
  domicilioSocial: 'POLIGONO INDUSTRIAL LOS ALMENDROS, CALLE DE LA INDUSTRIA NUMERO 145, NAVE 7',
  email: 'administracion.facturacion.clientes@empresa-de-prueba-ficticia.example',
};
const png = (ancho: number, alto: number, color: [number, number, number]) => ({ bytes: pngLiso(ancho, alto, color), mime: 'image/png' });

describe('sin QR, las plantillas A y B se dibujan igual que en origin/main', () => {
  // Huellas (sha256 del contenido normalizado de las paginas) sacadas con el codigo de origin/main
  // (497194b) el 15-10-2026 y el 18-10-2026, con estos mismos datos. Si cambian, el PDF sin QR ya no
  // es el de main. La factura del lector, aunque tenga registro, sale con el dibujo de siempre.
  // Si main cambia A o B a proposito: saca una copia de main (git archive <commit> | tar -x -C <carpeta>),
  // pinta estos casos con su renderizarFactura y pon aqui el sha256 de contenidoNormalizado de cada uno
  // (el fallo de Jest ya da la huella nueva). Para ver que ha cambiado, compara los dos
  // contenidoNormalizado: es texto, con cada operador y su posicion.
  const conRegistro = { verifactu: { url: URL_PRO, entorno: 'PRODUCCION' as const } };
  const borradorConRegistro = { ...conRegistro, estadoDocumento: 'BORRADOR', numeroCompleto: null };
  const logoAlto = { bytes: pngLiso(100, 200, [20, 120, 160]), mime: 'image/png' };
  const conEmail = { ...comunPdfQr.emisor, email: 'facturas@empresa-de-prueba.example' };
  const emisorUS = { ...comunPdfQr.emisor, denominacion: 'TEST TRADING LLC', nif: '12-3456789', pais: 'US', codigoPostal: '33101', municipio: 'MIAMI', provincia: 'FL', datosRegistrales: null, registroMercantilProvincia: null };
  const muchas = (d: DatosFacturaPdf, n: number) => ({ ...d, lineas: Array.from({ length: n }, () => d.lineas).flat() });
  const casos: Array<[string, () => DatosFacturaPdf, string]> = [
    ['A', () => plantillaAPdfQr(), 'd321d9eede01e4e1881f7752ac67bb03f16dbf47957964aa461cd0d9eb36955c'],
    ['A con logo', () => plantillaAPdfQr({ logo: logosPdfQr().logo }), '4b9e9f23fc8186f2b0db532bd699435f215ca05b4b549907871473703335e44b'],
    ['A rectificativa', () => plantillaAPdfQr({ ...rectificativaPdfQr, logo: logosPdfQr().logo }), 'b644cfed5899f86084c2e08b1cc9dae9ebc1e32d59bb02a9df2df9d4d61f1628'],
    ['A cliente de fuera largo', () => plantillaAPdfQr({ cliente: clienteLargoPdfQr, logo: logosPdfQr().logo }), '9f19c9929e7f13cd512b06658734f2d2499b7a603cac84bb19cfa6406d707a07'],
    ['A borrador (con registro)', () => plantillaAPdfQr({ ...borradorConRegistro, logo: logosPdfQr().logo }), '5a78899b70780836d2b3d19078d06656867f4265f485a7853b333e46e574cff6'],
    ['A proforma', () => plantillaAPdfQr({ estadoDocumento: 'PROFORMA', numeroCompleto: 'P-1' }), 'd9684b23875380cbaedcaee809493af0036f32689eb53c552295496997dfa571'],
    ['A de varias paginas', () => muchas(plantillaAPdfQr({ logo: logosPdfQr().logo }), 9), 'e96da58128ab230103bcad42eed3c7a21c3b41640729246bcdabdf83ce4fde49'],
    ['A con logo alto y email', () => plantillaAPdfQr({ logo: logoAlto, emisor: conEmail }), '40e1f8835acaddf266cf077bd1d37a0bcf4605df15320664f07eac30f6ad6319'],
    ['A simplificada', () => plantillaAPdfQr({ tipoFactura: 'F2', logo: logosPdfQr().logo }), 'f77ce5c9bb5466f1480384f0d599cd6867d0dc3c83d4260efe0893803fcce857'],
    ['A del lector (con registro)', () => plantillaAPdfQr({ ...conRegistro, registroLector: true, logo: logosPdfQr().logo }), '61b40d63c87d5cd56d1fdff17b7f12455a0217200e06b5ccd5b8c453afa0c65e'],
    ['A con la empresa larga', () => plantillaAPdfQr({ emisor: emisorLargo, logo: logosPdfQr().logo }), '84e8c09246e0fc4b410f61ad7041af715f95ee5d83fd34efb4927cc1b4c200c3'],
    ['A de una empresa de EE. UU.', () => plantillaAPdfQr({ emisor: emisorUS, moneda: 'USD', monedaCuenta: 'USD', conIva: false }), 'd4c7a67229b73c3235b4c65cdb7a086dedb2718606e821a4bc0748f4318ee5e6'],
    ['B', () => plantillaBPdfQr(logosPdfQr()), '76a638f0e3421d3aad640802ad0ff1061a6e3d6d71da9052a5ee5e9d027ad15a'],
    ['B sin logos', () => plantillaBPdfQr(), '1dfcf2a3690310e32d3b3ec09fe89d1df26acd6ecf3812519a7ae245e5cdb860'],
    ['B rectificativa', () => plantillaBPdfQr({ ...rectificativaPdfQr, ...logosPdfQr() }), '77953cea0667bb7316be82f57fa56fe34a7833b525cfe432f8b64e5429dc2847'],
    ['B cliente de fuera largo', () => plantillaBPdfQr({ cliente: clienteLargoPdfQr, ...logosPdfQr(), obra: 'REFORMA LOCAL CALLE MAYOR' }), 'c877d97b0f36dbd92be81e513c2d8267249f6b535ecbf0261763ddcdca4c0b65'],
    ['B borrador (con registro)', () => plantillaBPdfQr({ ...borradorConRegistro, ...logosPdfQr() }), 'd5dc4d501614f4f36fc8757b1263b74cca4ee7f58d97b4fe60b6131844fea8f9'],
    ['B de varias paginas', () => muchas(plantillaBPdfQr(logosPdfQr()), 16), '1ed610707d90f8e5c4b46f42777a7aa0092be6896ae98ef7cab7b1cc5d691550'],
    ['B con la empresa larga', () => plantillaBPdfQr({ emisor: emisorLargo, ...logosPdfQr() }), '81968259d5f7b974313995e532755e3bbc2904ef29b6a56b70775961ca5a0f0d'],
    ['B solo con el logo de la marca', () => plantillaBPdfQr({ logoMarca: logosPdfQr().logoMarca }), 'fc844b16111a5df123fd4986b053c35ce3054126f1d006f8827b6d48280b97a3'],
    ['B proforma (con registro)', () => plantillaBPdfQr({ ...conRegistro, ...logosPdfQr(), estadoDocumento: 'PROFORMA', numeroCompleto: 'P-1' }), '1cab77b0151811eb723fdf33f07cdc5ab76be74d7d83c5583e43300adb28d64e'],
    ['B del lector (con registro)', () => plantillaBPdfQr({ ...conRegistro, registroLector: true, ...logosPdfQr() }), '57f94a127bc3f0b69da3f5c042acb80722e1d94a65a35ad2c5ab4a9655b30eb1'],
  ];
  it.each(casos)('%s', async (_n, datos, huella) => {
    const c = await contenidoNormalizado(await renderizarFactura(datos()));
    expect(createHash('sha256').update(c).digest('hex')).toBe(huella);
  });
});

describe('plantilla A con QR: todo en la cabecera', () => {
  it('NZ004_26 cabe en una pagina con sus cifras (produccion, PRUEBAS, con logo y rectificativa)', async () => {
    const logo = logosPdfQr().logo;
    for (const d of [plantillaAPdfQr(conPro), plantillaAPdfQr({ ...conPru, logo }), plantillaAPdfQr({ ...conPro, logo }), plantillaAPdfQr({ ...conPro, ...rectificativaPdfQr, logo })]) {
      const ts = await textosDePdf(await renderizarFactura(d));
      expect(Math.max(...ts.map((t) => t.pagina))).toBe(1);
      for (const cifra of ['7.152,63 €', '1.502,05 €', '8.654,68 €']) expect(ts.some((t) => t.texto === cifra)).toBe(true);
      expect(ts.filter((t) => t.texto === TITULO_QR)).toHaveLength(1);
    }
    // En PRUEBAS, con su marca de agua.
    const pru = await textosDePdf(await renderizarFactura(plantillaAPdfQr({ ...conPru, logo })));
    expect(pru.some((t) => t.texto === MARCA_PRUEBAS)).toBe(true);
  });

  it('el CLIENTE va arriba a la derecha (donde sin QR va el logo) y no hay CLIENTE de ancho completo; la empresa, a la izquierda', async () => {
    const b = bloqueA();
    const ts = (await textosDePdf(await renderizarFactura(plantillaAPdfQr({ ...conPro, ...logosPdfQr() })))).filter((t) => t.pagina === 1);
    const etq = unico(ts, 'CLIENTE:');
    const nombre = unico(ts, 'CLIENTE FICTICIO SL');
    const numero = unico(ts, 'Nº FACTURA:');
    for (const t of [etq, nombre, unico(ts, 'CIF: B00000000'), unico(ts, 'CALLE FALSA, 1')]) {
      expect(t.x).toBeGreaterThan(CLIENTE_QR_A.izq);
      expect(t.derecha).toBeLessThan(CLIENTE_QR_A.der);
      // En la cabecera: por encima del fondo del QR y del recuadro del numero.
      expect(t.y).toBeGreaterThan(b.cajaBloque.y);
    }
    // El recuadro del numero, debajo de la cabecera; «FACTURA», en la columna de la empresa.
    expect(numero.y).toBeLessThan(b.cajaBloque.y);
    const titulo = unico(ts, 'FACTURA');
    expect(titulo.derecha).toBeLessThan(b.cajaBloque.x);
    expect(titulo.y).toBeGreaterThan(numero.y);
    const empresa = unico(ts, 'EMPRESA DE PRUEBA S.L.');
    expect(empresa.derecha).toBeLessThan(EMPRESA_A.der);
    // Sin QR, el CLIENTE de siempre: a la izquierda y debajo del numero.
    const sin = (await textosDePdf(await renderizarFactura(plantillaAPdfQr(logosPdfQr())))).filter((t) => t.pagina === 1);
    expect(unico(sin, 'CLIENTE:').x).toBeLessThan(EMPRESA_A.der);
    expect(unico(sin, 'CLIENTE:').y).toBeLessThan(unico(sin, 'Nº FACTURA:').y);
  });

  it('el QR, en el hueco entre los dos recuadros: ningun borde, fondo, logo ni texto pisa su bloque (tambien en PRUEBAS y en la rectificativa)', async () => {
    const b = bloqueA();
    expect(b.cajaBloque.x).toBeGreaterThan(EMPRESA_A.der);
    expect(b.cajaBloque.x + b.cajaBloque.ancho).toBeLessThan(CLIENTE_QR_A.izq);
    // QR de 35 mm con sus 6 mm de zona en blanco (D4 del plan), como en la B.
    expect(b.cajaQr.ancho).toBeCloseTo((35 * 72) / 25.4, 5);
    expect(b.cajaQr.x - b.cajaBlanca.x).toBeCloseTo((6 * 72) / 25.4, 5);
    const logo = logosPdfQr().logo;
    for (const d of [plantillaAPdfQr({ ...conPro, logo }), plantillaAPdfQr(conPro), plantillaAPdfQr({ ...conPru, logo }), plantillaAPdfQr({ ...conPro, ...rectificativaPdfQr, logo })]) {
      await nadaPisaElQr(await renderizarFactura(d), b);
    }
  });

  it('el logo va encima del recuadro de la empresa, centrado y sin deformar; el email largo se parte detras de la @ en su columna, a su letra', async () => {
    const email = 'administracion.facturacion.clientes@empresa-de-prueba-ficticia.example';
    const datos = plantillaAPdfQr({ ...conPro, logo: { bytes: pngLiso(300, 110, [26, 77, 153]), mime: 'image/png' }, emisor: { ...comunPdfQr.emisor, email } });
    const pdf = await renderizarFactura(datos);
    const { imagenes } = await figurasDePdf(pdf);
    expect(imagenes).toHaveLength(1);
    const [im] = imagenes;
    expect(im.ancho / im.alto).toBeCloseTo(300 / 110, 3);
    expect(im.x + im.ancho / 2).toBeCloseTo((EMPRESA_A.izq + EMPRESA_A.der) / 2, 3);
    const ts = (await textosDePdf(pdf)).filter((t) => t.pagina === 1);
    expect(unico(ts, 'EMPRESA DE PRUEBA S.L.').y).toBeLessThan(im.y);
    // A su letra (8,8) no cabe en una linea: en dos, la primera acaba en la @.
    const ls = partidoEn(ts, email, '');
    expect(ls.map((t) => t.texto)).toEqual(['administracion.facturacion.clientes@', 'empresa-de-prueba-ficticia.example']);
    for (const t of ls) {
      expect(t.tam).toBeCloseTo(8.8, 5);
      expect(t.derecha).toBeLessThan(bloqueA().cajaBloque.x);
    }
    // Uno corto, en una linea.
    const corto = (await textosDePdf(await renderizarFactura(plantillaAPdfQr({ ...conPro, emisor: { ...comunPdfQr.emisor, email: 'facturas@empresa.example' } })))).filter((t) => t.pagina === 1);
    expect(unico(corto, 'facturas@empresa.example').tam).toBeCloseTo(8.8, 5);
    await nadaPisaElQr(pdf, bloqueA());
  });

  it('cliente de fuera con el nombre y la direccion largos: partido dentro de su recuadro, con su NIF-IVA y el pais, sin solaparse con nada', async () => {
    const pdf = await renderizarFactura(plantillaAPdfQr({ ...conPro, ...logosPdfQr(), cliente: clienteLargoPdfQr }));
    const ts = (await textosDePdf(pdf)).filter((t) => t.pagina === 1);
    const numero = unico(ts, 'Nº FACTURA:');
    const cabecera = ts.filter((t) => t.y > numero.y && !esMarca(t));
    const cliente = cabecera.filter((t) => t.x > CLIENTE_QR_A.izq);
    expect(cliente.map((t) => t.texto)).toEqual(expect.arrayContaining(['CLIENTE:', 'NIF-IVA (VAT): DE123456789', 'ALEMANIA']));
    // El nombre y la direccion, partidos en varias lineas.
    expect(cliente.length).toBeGreaterThan(8);
    for (const t of cliente) expect(t.derecha).toBeLessThan(CLIENTE_QR_A.der - 1.7);
    sinSolapes(cabecera);
    await nadaPisaElQr(pdf, bloqueA());
    // Sigue en una pagina.
    expect(Math.max(...(await textosDePdf(pdf)).map((t) => t.pagina))).toBe(1);
  });

  it('la empresa con el nombre, el domicilio y el email largos: partidos dentro de su recuadro, sin llegar al QR', async () => {
    const pdf = await renderizarFactura(plantillaAPdfQr({ ...conPro, emisor: emisorLargo, logo: logosPdfQr().logo }));
    const ts = (await textosDePdf(pdf)).filter((t) => t.pagina === 1);
    for (const completo of [emisorLargo.denominacion, emisorLargo.domicilioSocial]) {
      const ls = partidoEn(ts, completo);
      expect(ls.length).toBeGreaterThan(1);
      for (const t of ls) {
        expect(t.x).toBeGreaterThan(EMPRESA_A.izq + 1.7);
        // La cursiva se inclina hasta 0,2 de la letra; el borde de dentro del recuadro, en 236,5.
        expect(t.derecha + 0.2 * t.tam).toBeLessThan(236.5);
      }
    }
    const email = partidoEn(ts, emisorLargo.email, '');
    expect(email).toHaveLength(2);
    for (const t of email) expect(t.derecha).toBeLessThan(bloqueA().cajaBloque.x);
    const cabecera = ts.filter((t) => t.y > unico(ts, 'Nº FACTURA:').y && !esMarca(t));
    sinSolapes(cabecera);
    // Nada por debajo de la letra minima de la A (5 pt).
    for (const t of cabecera) expect(t.tam).toBeGreaterThanOrEqual(5 - 1e-6);
    await nadaPisaElQr(pdf, bloqueA());
  });

  it.each<[string, Partial<DatosFacturaPdf>]>([
    ['sin logo', conPro],
    ['con un logo alto y estrecho', { ...conPro, logo: png(100, 200, [20, 120, 160]) }],
    ['simplificada, con la empresa y el email largos', { ...conPro, tipoFactura: 'F2', emisor: emisorLargo, logo: png(400, 80, [20, 120, 60]) }],
    ['rectificativa en PRUEBAS', { ...conPru, ...rectificativaPdfQr, logo: logosPdfQr().logo }],
  ])('%s: nada se solapa en la cabecera, el QR queda libre y cabe en una pagina', async (_n, extra) => {
    const pdf = await renderizarFactura(plantillaAPdfQr(extra));
    const ts = (await textosDePdf(pdf)).filter((t) => t.pagina === 1);
    const numero = unico(ts, 'Nº FACTURA:');
    sinSolapes(ts.filter((t) => t.y > numero.y && !esMarca(t)));
    await nadaPisaElQr(pdf, bloqueA());
    expect(Math.max(...(await textosDePdf(pdf)).map((t) => t.pagina))).toBe(1);
    for (const cifra of ['7.152,63 €', '1.502,05 €', '8.654,68 €']) expect(ts.some((t) => t.texto === cifra)).toBe(true);
  });

  it('varias paginas con la empresa larga: en las siguientes, el nombre de la empresa no llega al titulo', async () => {
    const d = plantillaAPdfQr({ ...conPro, emisor: emisorLargo, logo: logosPdfQr().logo });
    const ts = await textosDePdf(await renderizarFactura({ ...d, lineas: Array.from({ length: 9 }, () => d.lineas).flat() }));
    expect(Math.max(...ts.map((t) => t.pagina))).toBeGreaterThan(1);
    sinChoqueEnCabeceraBreve(ts, 'FACTURA A-1 (continuación)');
  });
});

/** En cada pagina siguiente, el nombre de la empresa (partido o no) acaba antes de que empiece el titulo breve. */
function sinChoqueEnCabeceraBreve(ts: TextoPdf[], titulo: string) {
  const titulos = ts.filter((t) => t.texto === titulo);
  expect(titulos.length).toBeGreaterThan(0);
  for (const tt of titulos) {
    const pagina = ts.filter((t) => t.pagina === tt.pagina && t !== tt && t.y > tt.y - 15);
    const nombre = partidoEn(pagina, emisorLargo.denominacion);
    for (const t of nombre) expect(t.derecha).toBeLessThan(tt.x);
    sinSolapes(pagina.concat(tt));
  }
}

describe('plantilla B con QR: todo en la cabecera', () => {
  it('NZ013_26 con sus cifras; CLIENTE arriba a la derecha; empresa y FACTURA:/FECHA: a la izquierda; OBRA debajo', async () => {
    const b = bloqueB();
    for (const d of [plantillaBPdfQr({ ...conPro, ...logosPdfQr() }), plantillaBPdfQr({ ...conPru, ...logosPdfQr() }), plantillaBPdfQr(conPro)]) {
      const ts = (await textosDePdf(await renderizarFactura(d))).filter((t) => t.pagina === 1);
      for (const cifra of ['600,74 €', '126,16 €', '726,90 €']) expect(ts.some((t) => t.texto === cifra)).toBe(true);
      for (const s of ['CLIENTE', 'CLIENTE FICTICIO SL', 'NIF: B00000000', 'CALLE FALSA, 1']) {
        const t = unico(ts, s);
        expect(t.x).toBeGreaterThan(CLIENTE_QR_B.izq);
        expect(t.derecha).toBeLessThan(CLIENTE_QR_B.der);
        expect(t.y).toBeGreaterThan(b.cajaBloque.y);
      }
      for (const s of ['EMPRESA DE PRUEBA S.L.', 'FACTURA:', 'FECHA:']) {
        const t = unico(ts, s);
        expect(t.derecha).toBeLessThan(b.cajaBloque.x);
        expect(t.y).toBeGreaterThan(b.cajaBloque.y);
      }
      expect(unico(ts, 'OBRA:').y).toBeLessThan(b.cajaBloque.y);
    }
  });

  it('el QR, en el hueco entre la columna de la izquierda y el CLIENTE: nada pisa su bloque (con y sin logos, en PRUEBAS y en la rectificativa)', async () => {
    const b = bloqueB();
    expect(b.cajaBloque.x).toBeGreaterThan(LOGOS_QR_B.der);
    expect(b.cajaBloque.x + b.cajaBloque.ancho).toBeLessThan(CLIENTE_QR_B.izq);
    expect(b.cajaQr.ancho).toBeCloseTo((35 * 72) / 25.4, 5);
    expect(b.cajaQr.x - b.cajaBlanca.x).toBeCloseTo((6 * 72) / 25.4, 5);
    for (const d of [plantillaBPdfQr({ ...conPro, ...logosPdfQr() }), plantillaBPdfQr(conPro), plantillaBPdfQr({ ...conPru, ...logosPdfQr() }), plantillaBPdfQr({ ...conPro, ...rectificativaPdfQr, ...logosPdfQr() })]) {
      await nadaPisaElQr(await renderizarFactura(d), b);
    }
  });

  it('los dos logos, uno al lado del otro encima del recuadro de la empresa y sin deformar; sin el de la marca, el de la empresa solo', async () => {
    const pdf = await renderizarFactura(plantillaBPdfQr({ ...conPro, ...logosPdfQr() }));
    const { imagenes } = await figurasDePdf(pdf);
    expect(imagenes).toHaveLength(2);
    const [logo, marca] = [...imagenes].sort((a, z) => a.x - z.x);
    for (const im of [logo, marca]) {
      expect(im.ancho / im.alto).toBeCloseTo(300 / 110, 3);
      expect(im.x).toBeGreaterThanOrEqual(LOGOS_QR_B.izq - TOL);
      expect(im.x + im.ancho).toBeLessThanOrEqual(LOGOS_QR_B.der + TOL);
    }
    expect(logo.alto).toBeCloseTo(marca.alto, 5);
    expect(logo.y).toBeCloseTo(marca.y, 5);
    expect(marca.x).toBeGreaterThan(logo.x + logo.ancho);
    // Los dos juntos, centrados sobre el recuadro de la empresa (que va de LOGOS_QR_B.izq a LOGOS_QR_B.der).
    const centro = (LOGOS_QR_B.izq + LOGOS_QR_B.der) / 2;
    expect((logo.x + marca.x + marca.ancho) / 2).toBeCloseTo(centro, 3);
    const ts = (await textosDePdf(pdf)).filter((t) => t.pagina === 1);
    expect(unico(ts, 'EMPRESA DE PRUEBA S.L.').y).toBeLessThan(logo.y);

    const solo = await figurasDePdf(await renderizarFactura(plantillaBPdfQr({ ...conPro, logo: logosPdfQr().logo })));
    expect(solo.imagenes).toHaveLength(1);
    const [s] = solo.imagenes;
    expect(s.ancho / s.alto).toBeCloseTo(300 / 110, 3);
    expect(s.alto).toBeGreaterThan(logo.alto);
    expect(s.x + s.ancho / 2).toBeCloseTo(centro, 3);
    expect(s.x).toBeGreaterThanOrEqual(LOGOS_QR_B.izq - TOL);
    expect(s.x + s.ancho).toBeLessThanOrEqual(LOGOS_QR_B.der + TOL);
  });

  it('un numero de factura de 60 caracteres (el maximo de la AEAT) no sale de su recuadro ni llega al QR, y no baja de la letra minima', async () => {
    const numero = 'SERIE-DE-PRUEBA-MUY-LARGA-2026-00000000000000000000000000001';
    expect(numero).toHaveLength(60);
    const pdf = await renderizarFactura(plantillaBPdfQr({ ...conPro, ...logosPdfQr(), numeroCompleto: numero }));
    const ts = (await textosDePdf(pdf)).filter((t) => t.pagina === 1);
    const ls = partidoEn(ts, numero, '');
    expect(ls.length).toBeGreaterThan(1);
    const fecha = unico(ts, 'FECHA:');
    for (const t of ls) {
      // Dentro del recuadro de FACTURA: (de 47,4 a 143,0) y encima de FECHA:.
      expect(t.x).toBeGreaterThan(47.4);
      expect(t.derecha).toBeLessThan(143.0);
      expect(t.tam).toBeGreaterThanOrEqual(4.5 - 1e-6);
      expect(t.y - 0.25 * t.tam).toBeGreaterThan(fecha.y + 0.75 * fecha.tam);
    }
    sinSolapes(ts.filter((t) => t.y > unico(ts, 'OBRA:').y && !esMarca(t)));
    await nadaPisaElQr(pdf, bloqueB());
  });

  it('varias paginas con la empresa larga: en las siguientes, el nombre de la empresa no llega al titulo', async () => {
    const d = plantillaBPdfQr({ ...conPro, emisor: emisorLargo, ...logosPdfQr() });
    const ts = await textosDePdf(await renderizarFactura({ ...d, lineas: Array.from({ length: 16 }, () => d.lineas).flat() }));
    expect(Math.max(...ts.map((t) => t.pagina))).toBeGreaterThan(1);
    sinChoqueEnCabeceraBreve(ts, 'Factura B-13 (continuación)');
  });

  it('cliente de fuera con el nombre y la direccion largos y empresa sin logos: todo dentro de su recuadro, sin solaparse con nada', async () => {
    const pdf = await renderizarFactura(plantillaBPdfQr({ ...conPro, cliente: clienteLargoPdfQr, obra: 'REFORMA INTEGRAL DEL LOCAL COMERCIAL DE LA CALLE MAYOR 14' }));
    const ts = (await textosDePdf(pdf)).filter((t) => t.pagina === 1);
    const obra = unico(ts, 'OBRA:');
    const cabecera = ts.filter((t) => t.y > obra.y && !esMarca(t));
    const cliente = cabecera.filter((t) => t.x > CLIENTE_QR_B.izq);
    expect(cliente.map((t) => t.texto)).toEqual(expect.arrayContaining(['CLIENTE', 'NIF-IVA (VAT): DE123456789', 'ALEMANIA']));
    expect(cliente.length).toBeGreaterThan(8);
    for (const t of cliente) expect(t.derecha + 0.2 * t.tam).toBeLessThan(CLIENTE_QR_B.der - 1.7);
    sinSolapes(cabecera);
    await nadaPisaElQr(pdf, bloqueB());
  });

  it('la empresa con el nombre y el domicilio largos: partidos dentro de su recuadro; FACTURA: y FECHA: bajan', async () => {
    const pdf = await renderizarFactura(plantillaBPdfQr({ ...conPro, emisor: emisorLargo, ...logosPdfQr() }));
    const ts = (await textosDePdf(pdf)).filter((t) => t.pagina === 1);
    let fondo = Infinity;
    for (const completo of [emisorLargo.denominacion, emisorLargo.domicilioSocial]) {
      const ls = partidoEn(ts, completo);
      expect(ls.length).toBeGreaterThan(1);
      for (const t of ls) {
        expect(t.x).toBeGreaterThan(47.4);
        expect(t.derecha + 0.2 * t.tam).toBeLessThan(186.4);
        fondo = Math.min(fondo, t.y);
      }
    }
    expect(unico(ts, 'FACTURA:').y).toBeLessThan(fondo);
    sinSolapes(ts.filter((t) => t.y > unico(ts, 'OBRA:').y && !esMarca(t)));
    await nadaPisaElQr(pdf, bloqueB());
  });

  it.each<[string, Partial<DatosFacturaPdf>]>([
    ['sin logos', conPro],
    ['solo con el logo de la marca, alto y estrecho', { ...conPro, logoMarca: png(100, 200, [20, 120, 160]) }],
    ['con dos logos muy anchos (la marca va debajo)', { ...conPro, logo: png(400, 80, [20, 120, 60]), logoMarca: png(420, 70, [120, 20, 120]) }],
    ['con la empresa larga, rectificativa en PRUEBAS', { ...conPru, ...rectificativaPdfQr, ...logosPdfQr(), emisor: emisorLargo }],
  ])('%s: nada se solapa en la cabecera, el QR queda libre y las cifras siguen', async (_n, extra) => {
    const pdf = await renderizarFactura(plantillaBPdfQr(extra));
    const ts = (await textosDePdf(pdf)).filter((t) => t.pagina === 1);
    const obra = unico(ts, 'OBRA:');
    sinSolapes(ts.filter((t) => t.y > obra.y && !esMarca(t)));
    await nadaPisaElQr(pdf, bloqueB());
    for (const cifra of ['600,74 €', '126,16 €', '726,90 €']) expect(ts.some((t) => t.texto === cifra)).toBe(true);
    // Ningun logo se deforma ni se sale de su sitio.
    const { imagenes } = await figurasDePdf(pdf);
    for (const im of imagenes) {
      expect(im.x).toBeGreaterThanOrEqual(LOGOS_QR_B.izq - TOL);
      expect(im.x + im.ancho).toBeLessThanOrEqual(LOGOS_QR_B.der + TOL);
      expect(ALTO - (im.y + im.alto)).toBeGreaterThanOrEqual(LOGOS_QR_B.arriba - TOL);
    }
  });
});

describe('logosCabeceraQrB: donde van los logos de la B con QR', () => {
  const zona = { izq: LOGOS_QR_B.izq, der: LOGOS_QR_B.der, arriba: LOGOS_QR_B.arriba, alto: 56, centro: 117 };
  const enZona = (s: { x: number; top: number; ancho: number; alto: number }) => {
    expect(s.x).toBeGreaterThanOrEqual(zona.izq - TOL);
    expect(s.x + s.ancho).toBeLessThanOrEqual(zona.der + TOL);
    expect(s.top).toBeGreaterThanOrEqual(zona.arriba - TOL);
    expect(s.top + s.alto).toBeLessThanOrEqual(zona.arriba + zona.alto + TOL);
  };

  it('dos logos que caben al lado: mismo alto, sin deformar y sin tocarse', () => {
    const [a, z] = logosCabeceraQrB({ ancho: 300, alto: 110 }, { ancho: 200, alto: 100 }, zona);
    expect(a && z).toBeTruthy();
    enZona(a!);
    enZona(z!);
    expect(a!.alto).toBeCloseTo(z!.alto, 6);
    expect(a!.ancho / a!.alto).toBeCloseTo(300 / 110, 6);
    expect(z!.ancho / z!.alto).toBeCloseTo(2, 6);
    expect(z!.x).toBeGreaterThan(a!.x + a!.ancho);
  });

  it('dos logos muy anchos: el de la marca debajo del primero, mas pequeño, sin deformar', () => {
    const [a, z] = logosCabeceraQrB({ ancho: 400, alto: 80 }, { ancho: 420, alto: 70 }, zona);
    enZona(a!);
    enZona(z!);
    expect(z!.top).toBeGreaterThan(a!.top + a!.alto);
    expect(z!.alto).toBeLessThan(a!.alto);
    expect(a!.ancho / a!.alto).toBeCloseTo(5, 6);
    expect(z!.ancho / z!.alto).toBeCloseTo(6, 6);
  });

  it('uno solo ocupa la zona; sin ninguno, nada', () => {
    const [a, z] = logosCabeceraQrB(null, { ancho: 100, alto: 200 }, zona);
    expect(a).toBeNull();
    enZona(z!);
    expect(z!.alto).toBeCloseTo(zona.alto, 6);
    expect(z!.ancho / z!.alto).toBeCloseTo(0.5, 6);
    expect(logosCabeceraQrB(null, null, zona)).toEqual([null, null]);
  });
});

describe('partirAchicando: un texto largo en pocas lineas', () => {
  const texto = 'DISTRIBUCIONES Y MATERIALES DE CONSTRUCCION DEL MEDITERRANEO SOCIEDAD LIMITADA';
  it('la mayor letra con la que sale en dos lineas como mucho, cada una dentro del ancho', () => {
    const { lineas, tam } = partirAchicando(texto, fuentes.negrita, 12.2, 5, 189);
    expect(lineas).toHaveLength(2);
    expect(lineas.join(' ')).toBe(texto);
    for (const l of lineas) expect(fuentes.negrita.widthOfTextAtSize(l, tam)).toBeLessThanOrEqual(189);
    // Con 0,2 mas ya no cabria en dos.
    expect(partirAchicando(texto, fuentes.negrita, tam + 0.2, tam + 0.2, 189).lineas.length).toBeGreaterThan(2);
    // Si cabe en una, en una y a la letra pedida.
    expect(partirAchicando('CORTO', fuentes.negrita, 12.2, 5, 189)).toEqual({ lineas: ['CORTO'], tam: 12.2 });
  });

  it('si ni con la letra minima cabe en esas lineas, las que hagan falta con la minima, sin perder texto', () => {
    const { lineas, tam } = partirAchicando(texto, fuentes.negrita, 9, 4.5, 60);
    expect(tam).toBe(4.5);
    expect(lineas.length).toBeGreaterThan(2);
    expect(lineas.join(' ')).toBe(texto);
  });
});
