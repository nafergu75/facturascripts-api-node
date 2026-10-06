import { prisma } from '../config/database';
import { notFound } from '../utils/http-errors';
import { generarPdfA, type FilaPdf } from '../utils/pdf-a';

/**
 * PDF de una factura de venta (PDF/A, apto para conservarla).
 *
 * Incluye lo que exige el art. 6 del Reglamento de facturacion (RD 1619/2012):
 * numero y serie, fecha, datos del emisor y del cliente, descripcion de las
 * operaciones, base, tipo y cuota de IVA por tipo, y total. Las rectificativas
 * llevan la factura que corrigen y el motivo.
 * TODO (Verifactu paso 2): el QR y la leyenda "VERI*FACTU" cuando se envie a la AEAT.
 */

const eur = (n: number): string =>
  `${n.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
const fechaES = (iso: string): string => (/^\d{4}-\d{2}-\d{2}/.test(iso) ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : iso);
const cantidad = (n: number): string => n.toLocaleString('es-ES', { maximumFractionDigits: 3 });

/** El PDF no parte las lineas solo: los textos largos se cortan por palabras. */
function partir(texto: string, max = 95): string[] {
  const out: string[] = [];
  for (const parrafo of texto.split(/\r?\n/)) {
    let linea = '';
    for (const palabra of parrafo.split(/\s+/)) {
      if (linea && (linea + ' ' + palabra).length > max) {
        out.push(linea);
        linea = palabra;
      } else {
        linea = linea ? `${linea} ${palabra}` : palabra;
      }
    }
    out.push(linea);
  }
  return out;
}

const NOMBRE_TIPO: Record<string, string> = {
  F1: 'Factura',
  F2: 'Factura simplificada',
  R1: 'Factura rectificativa',
  R2: 'Factura rectificativa',
  R3: 'Factura rectificativa',
  R4: 'Factura rectificativa',
  R5: 'Factura rectificativa simplificada',
};

export async function generarPdfFactura(companyId: string, id: string): Promise<{ nombre: string; contenido: Buffer }> {
  const factura = await prisma.incomeInvoice.findFirst({
    where: { id, companyId },
    include: { lineas: true, customer: true },
  });
  if (!factura) throw notFound('Factura no encontrada.');

  const [empresa, original] = await Promise.all([
    prisma.legalConfig.findUnique({ where: { companyId } }).catch(() => null),
    factura.facturaOriginalId
      ? prisma.incomeInvoice.findFirst({ where: { id: factura.facturaOriginalId, companyId } })
      : Promise.resolve(null),
  ]);

  const esBorrador = factura.estadoDocumento !== 'FINAL';
  const tipo = NOMBRE_TIPO[factura.tipoFactura] ?? 'Factura';
  const titulo = esBorrador ? `${tipo} - BORRADOR (sin validez fiscal)` : `${tipo} ${factura.numeroCompleto}`;

  const filas: Array<string | FilaPdf> = [];
  filas.push(`Fecha de emisión: ${fechaES(factura.fechaEmision)}      Vencimiento: ${fechaES(factura.fechaVencimiento)}`);
  if (esBorrador) filas.push('Este documento es un borrador: todavía no tiene número ni es una factura.');
  filas.push('');

  filas.push('EMISOR');
  filas.push({ texto: empresa?.denominacion || '(Falta la denominación: Registro Mercantil > Datos para la memoria)', sangria: 1 });
  filas.push({ texto: `NIF: ${empresa?.nif || '(falta el NIF)'}`, sangria: 1 });
  const domEmpresa = [empresa?.domicilioSocial, [empresa?.codigoPostal, empresa?.municipio].filter(Boolean).join(' '), empresa?.provincia]
    .filter(Boolean)
    .join(', ');
  if (domEmpresa) filas.push({ texto: domEmpresa, sangria: 1 });
  filas.push('');

  const c = factura.customer;
  filas.push('CLIENTE');
  filas.push({ texto: c.nombreFiscal, sangria: 1 });
  filas.push({ texto: `NIF: ${c.nifCif}`, sangria: 1 });
  const domCliente = [c.direccion, [c.cp, c.municipio].filter(Boolean).join(' '), c.provincia, c.pais && c.pais !== 'ES' ? c.pais : null]
    .filter(Boolean)
    .join(', ');
  if (domCliente) filas.push({ texto: domCliente, sangria: 1 });
  filas.push('');

  if (factura.esRectificativa) {
    const tipoRect = factura.tipoRectificativa === 'S' ? 'por sustitución' : 'por diferencias';
    filas.push(`Rectifica la factura ${original?.numeroCompleto ?? '(original)'} de ${original ? fechaES(original.fechaEmision) : ''} (${tipoRect}).`);
    if (factura.motivoRectificacion) filas.push(...partir(`Motivo: ${factura.motivoRectificacion}`));
    filas.push('');
  }

  filas.push({ texto: 'Concepto', columnas: ['Cantidad', 'Precio', 'IVA', 'Importe'] });
  for (const l of factura.lineas) {
    const desc = l.descuentoPorcentaje ? ` (dto. ${cantidad(l.descuentoPorcentaje)} %)` : '';
    filas.push({
      texto: `${l.descripcion}${desc}`,
      columnas: [cantidad(l.cantidad), eur(l.precioUnitario), `${l.tipoIva} %`, eur(l.baseLine)],
    });
  }
  filas.push('');

  // Desglose por tipo de IVA (obligatorio cuando hay varios tipos).
  const porTipo = new Map<number, { base: number; cuota: number }>();
  for (const l of factura.lineas) {
    const t = porTipo.get(l.tipoIva) ?? { base: 0, cuota: 0 };
    t.base += l.baseLine;
    t.cuota += l.ivaImporte;
    porTipo.set(l.tipoIva, t);
  }
  filas.push({ texto: 'Desglose de IVA', columnas: ['Base', 'Tipo', 'Cuota'], separador: true });
  for (const [tipoIva, t] of [...porTipo.entries()].sort((a, b) => b[0] - a[0])) {
    filas.push({ texto: '', columnas: [eur(t.base), `${tipoIva} %`, eur(t.cuota)] });
    if (tipoIva === 0) filas.push({ texto: 'Operación exenta o no sujeta a IVA.', sangria: 1 });
  }
  filas.push('');

  filas.push({ texto: 'Base imponible', columnas: [eur(factura.baseTotal)], separador: true });
  filas.push({ texto: 'IVA', columnas: [eur(factura.ivaTotal)] });
  if (factura.retencionTotal) {
    const tipoRet = factura.lineas.find((l) => l.tipoRetencion)?.tipoRetencion ?? 0;
    filas.push({ texto: `Retención IRPF (${tipoRet} %)`, columnas: [`-${eur(factura.retencionTotal)}`] });
  }
  filas.push({ texto: 'TOTAL FACTURA', columnas: [eur(factura.totalFactura)], separador: true });

  if (factura.observaciones && !factura.esRectificativa) {
    filas.push('');
    filas.push('Observaciones:');
    for (const t of partir(factura.observaciones, 90)) filas.push({ texto: t, sangria: 1 });
  }

  const contenido = await generarPdfA(titulo, filas);
  const nombre = esBorrador ? `borrador_factura_${factura.id.slice(-6)}.pdf` : `factura_${factura.numeroCompleto}.pdf`;
  return { nombre: nombre.replace(/[^\w.-]/g, '_'), contenido };
}
