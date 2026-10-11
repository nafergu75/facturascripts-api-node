/**
 * Complemento con Claude de una lectura de Azure: lo fiscal espanol que
 * prebuilt-invoice no saca (IRPF, recargo, base por tipo, tipo de documento) y
 * los datos clave que Azure leyo con poca seguridad.
 *
 * Solo se llama si hace falta (decidirComplemento) y solo con el TEXTO que
 * devuelve Azure: sin el PDF ni la imagen, con el IBAN, los correos y los
 * telefonos tapados, y con un resumen de importes sin nombres ni direcciones.
 * Al log solo van el estado HTTP y error.type, nunca el texto mandado.
 */
import Anthropic from '@anthropic-ai/sdk';
import { normalizarAnthropicKey } from '../../config/env';
import { logger } from '../../config/logger';
import { esFechaReal } from '../../schemas/factura-gasto.schemas';
import { aCentimos, redondear2 } from '../../utils/money';
import { normalizarNif } from '../../utils/nif';
import { confianzaBaja, MOTIVO_BASE_DUDOSA, nifLeido } from './azure-factura.mapper';
import { UMBRAL_OK, type Campo, type Lector, type LecturaNormalizada, type TipoDocumentoLeido, type TramoLeido } from './tipos';
import { calcularCuadre, importesNegativos, validacionesSincronas, type ContextoValidacion } from './validaciones';

const OCR_MODEL = 'claude-opus-4-8';
/** Tiempo maximo del complemento, sin reintentos del SDK (seccion 7: no se reintenta). */
export const TIEMPO_COMPLEMENTO_MS = 30_000;
const MAX_TEXTO = 15_000;
const MIN_TEXTO = 40;

export type Disparador = 'C1' | 'C2' | 'C3' | 'C4' | 'C5' | 'C6';
export interface Pregunta {
  disparador: Disparador;
  texto: string;
}

export const AVISO_SIN_COMPLEMENTO = 'No se ha podido completar la retención, el recargo o el tipo de factura: revísalos a mano.';
const MOTIVO_SIN_COMPLEMENTO = 'No se ha podido completar con la IA: revísalo a mano.';
const TIPOS_DOCUMENTO: TipoDocumentoLeido[] = ['factura', 'simplificada', 'rectificativa', 'ticket', 'recibo', 'nomina', 'seguros_sociales', 'otro'];

const RE_RETENCION = /retenci[oó]n|IRPF|I\.R\.P\.F/i;
const RE_RECARGO = /recargo|\bR\.\s?E\.(?=\s|$)|equivalencia/i;
const RE_TIPO_DOCUMENTO = /rectificativ|abono|nota de cr[eé]dito|credit note|credit memo|n[oó]mina|recibo de salarios|\bRLC\b|\bTC-?1\b|liquidaci[oó]n de cotizaciones|ticket|simplificada/i;

/** Datos clave del lector (en ventas, el NIF que importa es el del cliente), con el campo de la herramienta en que se contestan. */
const camposClave = (l: LecturaNormalizada, lector: Lector): Array<[string, Campo<unknown>, string]> => [
  lector === 'VENTA' ? ['el NIF del cliente', l.receptor.nif, 'nif_cliente'] : ['el NIF del emisor', l.emisor.nif, 'nif_emisor'],
  ['el número de factura', l.numero, 'numero'],
  ['la fecha de la factura', l.fechaEmision, 'fecha'],
  ['el total a pagar', l.totales.totalAPagar, 'total_a_pagar'],
];

/** Las preguntas que hay que hacer a Claude. Vacia: no se le llama. */
export function decidirComplemento(l: LecturaNormalizada, contenido: string | null, lector: Lector): Pregunta[] {
  const t = contenido ?? '';
  const p: Pregunta[] = [];
  if (RE_RETENCION.test(t) || l.retencion) p.push({ disparador: 'C1', texto: 'Porcentaje e importe de la retención de IRPF, si la lleva.' });
  if (RE_RECARGO.test(t) || l.desglose.some((x) => x.tipoRecargo !== null)) p.push({ disparador: 'C2', texto: 'Recargo de equivalencia por tipo de IVA (tipo y cuota), si lo lleva.' });
  const cuadre = calcularCuadre(l);
  if (cuadre && cuadre.diferencia > 0) p.push({ disparador: 'C3', texto: 'Desglose completo (base, tipo y cuota de cada IVA) y los dos totales: los importes leídos no cuadran.' });
  if (!l.desglose.length || l.desglose.some((x) => x.base.motivo === MOTIVO_BASE_DUDOSA)) p.push({ disparador: 'C4', texto: 'Desglose completo: base, tipo y cuota de cada IVA.' });
  if (RE_TIPO_DOCUMENTO.test(t) || (!l.receptor.nif.valor && !l.receptor.nombre.valor) || importesNegativos(l)) {
    p.push({ disparador: 'C5', texto: 'Tipo de documento y, si es una factura rectificativa, el número de la factura que rectifica y el motivo.' });
  }
  for (const [nombre, c, campo] of camposClave(l, lector)) {
    const pregunta = c.valor === null ? `No se ha leído ${nombre}: búscalo.` : `Se leyó ${nombre} con poca seguridad (${String(c.valor)}): confírmalo o corrígelo.`;
    if (confianzaBaja(c)) p.push({ disparador: 'C6', texto: `${pregunta} Contesta en ${campo}.` });
  }
  return p;
}

/** El texto para Claude: sin marcas de codigos, cortado y con los datos personales tapados. */
export function prepararTexto(contenido: string): string {
  return contenido
    .replace(/:barcode:/g, '')
    .slice(0, MAX_TEXTO)
    .replace(/\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){2,7}(?:\s?[A-Z0-9]{1,4})?\b/g, '[IBAN]')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[CORREO]')
    .replace(/\b(Tel[eé]f(?:ono)?|Tel|Tlf|M[oó]vil|Phone|Fax)\.?\s*:?\s*[+\d][\d\s().-]{6,}\d/gi, '$1 [TELÉFONO]');
}

/** Lo leido por Azure, sin nombres ni direcciones. */
export function resumenParaClaude(l: LecturaNormalizada): Record<string, unknown> {
  return {
    numero: l.numero.valor,
    fecha: l.fechaEmision.valor,
    nif_emisor: l.emisor.nif.valor,
    nif_cliente: l.receptor.nif.valor,
    moneda: l.moneda.valor,
    desglose: l.desglose.map((t) => ({ tipo_iva: t.tipoIva, base: t.base.valor, cuota: t.cuota.valor, tipo_recargo: t.tipoRecargo, cuota_recargo: t.cuotaRecargo?.valor ?? null })),
    base_total: l.totales.base.valor,
    total_factura: l.totales.totalFactura.valor,
    total_a_pagar: l.totales.totalAPagar.valor,
  };
}

const INDICACIONES = `Eres un experto en facturas españolas. Te paso el TEXTO de una factura ya leída con OCR y los datos que ha sacado el lector.
Responde SOLO a las preguntas de abajo con la herramienta "completar_factura". Si el texto no lo dice, omite el campo: no inventes.
Importes con punto decimal y sin símbolo. Porcentajes como número (15, no "15 %"). Fechas AAAA-MM-DD. NIF sin el prefijo ES ni separadores.`;

export const HERRAMIENTA_COMPLETAR: Anthropic.Tool = {
  name: 'completar_factura',
  description: 'Completa los datos fiscales españoles de la factura (los que no aparezcan se omiten).',
  input_schema: {
    type: 'object',
    properties: {
      tipo_documento: { type: 'string', enum: TIPOS_DOCUMENTO },
      rectificativa: { type: 'object', properties: { numero_rectificada: { type: 'string' }, motivo: { type: 'string' } } },
      retencion: { type: 'object', properties: { porcentaje: { type: 'number' }, importe: { type: 'number' } } },
      desglose: {
        type: 'array',
        items: {
          type: 'object',
          properties: { tipo_iva: { type: 'number' }, base: { type: 'number' }, cuota: { type: 'number' }, tipo_recargo: { type: 'number' }, cuota_recargo: { type: 'number' } },
          required: ['tipo_iva', 'base'],
        },
      },
      numero: { type: 'string' },
      fecha: { type: 'string' },
      nif_emisor: { type: 'string', description: 'NIF de quien emite la factura' },
      nif_cliente: { type: 'string', description: 'NIF del cliente (destinatario de la factura)' },
      total_factura: { type: 'number', description: 'Base + IVA + recargo, sin restar la retención' },
      total_a_pagar: { type: 'number', description: 'Lo que hay que pagar, ya restada la retención' },
      concepto: { type: 'string', description: 'Concepto principal, en pocas palabras' },
    },
  },
};

/** El mensaje que se manda a Claude (solo texto). */
export function mensajeParaClaude(l: LecturaNormalizada, contenido: string, preguntas: Pregunta[]): Anthropic.MessageParam {
  const texto = [
    INDICACIONES,
    '',
    'TEXTO DE LA FACTURA:',
    prepararTexto(contenido),
    '',
    'DATOS DEL LECTOR:',
    JSON.stringify(resumenParaClaude(l)),
    '',
    'PREGUNTAS:',
    ...preguntas.map((p, i) => `${i + 1}. ${p.texto}`),
  ].join('\n');
  return { role: 'user', content: [{ type: 'text', text: texto }] };
}

// ---------------------------------------------------------------------------
// Mezcla con lo de Azure
// ---------------------------------------------------------------------------

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const cad = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const deClaude = <T>(valor: T): Campo<T> => ({ valor, confianza: null, fuente: 'claude' });
/** Leido con seguridad. Un dato calculado (p. ej. el total a pagar copiado del total) no cuenta, aunque herede una confianza. */
const fiable = (c: Campo<unknown>) =>
  (c.fuente === 'qr' && c.confianza === 1) || (c.fuente !== 'calculado' && typeof c.confianza === 'number' && c.confianza >= UMBRAL_OK && c.valor !== null);

/**
 * Azure seguro y la IA dice otra cosa: se queda el de Azure, para revisar.
 * Azure no lo leyo (o lo calculo): el de la IA. Azure lo leyo con poca
 * seguridad y la IA lee otra cosa: el de la IA, tambien para revisar.
 */
function mezclarCampo<T>(azure: Campo<T>, ia: T | null, iguales: (a: T, b: T) => boolean, mostrar: (x: T) => string = String): Campo<T> {
  if (ia === null) return azure;
  if (azure.valor !== null && iguales(azure.valor, ia)) return azure;
  if (fiable(azure)) return { ...azure, motivo: `Azure y la IA no coinciden (Azure: ${mostrar(azure.valor as T)}; IA: ${mostrar(ia)}).` };
  if (azure.valor === null || azure.fuente === 'calculado') return deClaude(ia);
  return { ...deClaude(ia), motivo: `Azure leyó «${mostrar(azure.valor)}» con poca seguridad y la IA lee «${mostrar(ia)}»: compruébalo.` };
}

export const MOTIVO_TOTAL_SIN_RETENCION = 'La factura solo trae el total a pagar: el total sin restar la retención se ha calculado. Compruébalo.';
export const MOTIVO_A_PAGAR_CALCULADO = 'La factura solo trae un total: el total a pagar se ha calculado restando la retención. Compruébalo.';

/**
 * Con retencion y un solo total impreso (total de la factura = total a pagar),
 * decide cual de los dos es y calcula el otro con las bases.
 */
function reconciliarRetencion(l: LecturaNormalizada): void {
  const ret = l.retencion?.importe.valor ?? 0;
  const tf = l.totales.totalFactura.valor;
  const tp = l.totales.totalAPagar.valor;
  if (!(ret > 0) || tf === null || tp === null || aCentimos(tf) !== aCentimos(tp)) return;
  if (!l.desglose.length || l.desglose.some((t) => t.base.valor === null)) return;
  const bruto = redondear2(l.desglose.reduce((s, t) => s + (t.base.valor ?? 0) + (t.cuota.valor ?? 0) + (t.cuotaRecargo?.valor ?? 0), 0));
  if (aCentimos(bruto - ret) === aCentimos(tf)) {
    l.totales.totalFactura = { valor: bruto, confianza: null, fuente: 'calculado', motivo: MOTIVO_TOTAL_SIN_RETENCION };
  } else if (aCentimos(bruto) === aCentimos(tf)) {
    l.totales.totalAPagar = { valor: redondear2(bruto - ret), confianza: null, fuente: 'calculado', motivo: MOTIVO_A_PAGAR_CALCULADO };
  }
}

const igualesTexto = (a: string, b: string) => a.toUpperCase().replace(/\s+/g, '') === b.toUpperCase().replace(/\s+/g, '');
const igualesImporte = (a: number, b: number) => aCentimos(a) === aCentimos(b);

/** Pasa el desglose (y los totales que salen de el) a otra lectura. */
function conDesglose(l: LecturaNormalizada, desglose: TramoLeido[]): LecturaNormalizada {
  const c = structuredClone(l);
  c.desglose = desglose;
  const recargo = redondear2(desglose.reduce((s, t) => s + (t.cuotaRecargo?.valor ?? 0), 0));
  c.totales.cuotaIva = deClaude(redondear2(desglose.reduce((s, t) => s + (t.cuota.valor ?? 0), 0)));
  c.totales.cuotaRecargo = { valor: recargo, confianza: null, fuente: recargo ? 'claude' : 'calculado' };
  return c;
}

export function mezclarComplemento(original: LecturaNormalizada, input: Record<string, unknown>, ctx: ContextoValidacion): LecturaNormalizada {
  let l = structuredClone(original);

  const tipo = cad(input.tipo_documento);
  if (tipo && (TIPOS_DOCUMENTO as string[]).includes(tipo)) l.tipoDocumento = deClaude(tipo as TipoDocumentoLeido);
  const rect = input.rectificativa as Record<string, unknown> | undefined;
  if (l.tipoDocumento.valor === 'rectificativa') {
    l.rectificativa = { numeroRectificada: deClaude(cad(rect?.numero_rectificada) ?? null) as Campo<string>, motivo: deClaude(cad(rect?.motivo) ?? null) as Campo<string> };
  }

  const ret = input.retencion as Record<string, unknown> | undefined;
  // Sin signo: un "-150" copiado del documento haria que el cuadre sumara en vez de restar.
  const absoluto = (x: number | null) => (x === null ? null : Math.abs(x));
  const pct = absoluto(num(ret?.porcentaje));
  const importeRet = absoluto(num(ret?.importe));
  if (pct !== null || importeRet !== null) {
    const base = l.desglose.reduce((s, t) => s + (t.base.valor ?? 0), 0);
    const imp = importeRet ?? (pct !== null ? redondear2((base * pct) / 100) : null);
    l.retencion = { tipo: deClaude(pct) as Campo<number>, importe: deClaude(imp) as Campo<number> };
    l.totales.retencion = deClaude(imp ?? 0);
  }

  l.numero = mezclarCampo(l.numero, cad(input.numero), igualesTexto);
  // Una fecha que no es AAAA-MM-DD real no pisa la de Azure.
  const fecha = cad(input.fecha);
  l.fechaEmision = mezclarCampo(l.fechaEmision, fecha && /^\d{4}-\d{2}-\d{2}$/.test(fecha) && esFechaReal(fecha) ? fecha : null, (a, b) => a === b);
  const mismoNif = (a: string, b: string) => normalizarNif(a) === normalizarNif(b);
  l.emisor.nif = mezclarCampo(l.emisor.nif, nifLeido(cad(input.nif_emisor)), mismoNif);
  l.receptor.nif = mezclarCampo(l.receptor.nif, nifLeido(cad(input.nif_cliente)), mismoNif);
  l.totales.totalFactura = mezclarCampo(l.totales.totalFactura, num(input.total_factura), igualesImporte, (x) => x.toFixed(2));
  l.totales.totalAPagar = mezclarCampo(l.totales.totalAPagar, num(input.total_a_pagar), igualesImporte, (x) => x.toFixed(2));
  const concepto = cad(input.concepto);
  if (!l.concepto.valor && concepto) l.concepto = deClaude(concepto);

  reconciliarRetencion(l);

  // El desglose de la IA sustituye al calculado solo si cuadra (V01 y V02).
  const tramos = Array.isArray(input.desglose) ? (input.desglose as Array<Record<string, unknown>>) : [];
  if (tramos.length) {
    const desglose: TramoLeido[] = tramos
      .filter((t) => num(t.tipo_iva) !== null && num(t.base) !== null)
      .map((t) => {
        const tipoIva = num(t.tipo_iva) as number;
        const base = num(t.base) as number;
        const tipoRecargo = num(t.tipo_recargo);
        return {
          tipoIva,
          base: deClaude(base),
          cuota: deClaude(num(t.cuota) ?? redondear2((base * tipoIva) / 100)),
          tipoRecargo,
          cuotaRecargo: tipoRecargo !== null ? deClaude(num(t.cuota_recargo) ?? redondear2((base * tipoRecargo) / 100)) : null,
        };
      });
    const propuesta = conDesglose(l, desglose);
    reconciliarRetencion(propuesta);
    const falla = validacionesSincronas(propuesta, ctx).some((v) => v.codigo === 'CUADRE' || v.codigo === 'CUOTA_TIPO');
    if (desglose.length && !falla) l = propuesta;
    else l.desglose.forEach((t) => (t.base.motivo ??= 'La IA no ha podido aclarar el desglose: compruébalo.'));
  }
  return l;
}

/** Marca para revisar lo que no se ha podido completar. */
function sinComplemento(original: LecturaNormalizada, preguntas: Pregunta[]): LecturaNormalizada {
  const l = structuredClone(original);
  const marcar = (c: Campo<unknown>) => (c.motivo ??= MOTIVO_SIN_COMPLEMENTO);
  const d = new Set(preguntas.map((p) => p.disparador));
  if (d.has('C1')) {
    if (l.retencion) [l.retencion.tipo, l.retencion.importe].forEach(marcar);
    else marcar(l.totales.totalAPagar);
  }
  if (d.has('C2') || d.has('C3') || d.has('C4')) l.desglose.forEach((t) => marcar(t.base));
  if (d.has('C3')) marcar(l.totales.totalAPagar);
  if (d.has('C5')) marcar(l.tipoDocumento);
  if (!l.avisos.includes(AVISO_SIN_COMPLEMENTO)) l.avisos.push(AVISO_SIN_COMPLEMENTO);
  return l;
}

export type ResultadoComplemento =
  | { tipo: 'completada'; lectura: LecturaNormalizada }
  /** Sin clave o Claude falla: lo de Azure con el aviso. */
  | { tipo: 'sin_complemento'; lectura: LecturaNormalizada }
  /** Azure no da texto con el que trabajar: hay que leer el documento con vision. */
  | { tipo: 'sin_texto' };

/** Cliente de Anthropic, o null sin ANTHROPIC_API_KEY. Se crea en cada llamada (tests y redespliegues). */
export function clienteAnthropic(): Anthropic | null {
  const clave = normalizarAnthropicKey(process.env.ANTHROPIC_API_KEY);
  return clave ? new Anthropic({ apiKey: clave, timeout: TIEMPO_COMPLEMENTO_MS, maxRetries: 0 }) : null;
}

export async function completarConClaude(l: LecturaNormalizada, contenido: string | null, preguntas: Pregunta[], ctx: ContextoValidacion): Promise<ResultadoComplemento> {
  if (!preguntas.length) return { tipo: 'completada', lectura: l };
  if (!contenido || contenido.replace(/:barcode:/g, '').trim().length < MIN_TEXTO) return { tipo: 'sin_texto' };
  const cliente = clienteAnthropic();
  if (!cliente) return { tipo: 'sin_complemento', lectura: sinComplemento(l, preguntas) };

  let respuesta: Anthropic.Message;
  try {
    respuesta = await cliente.messages.create({
      model: OCR_MODEL,
      max_tokens: 1024,
      thinking: { type: 'adaptive' },
      messages: [mensajeParaClaude(l, contenido, preguntas)],
      tools: [HERRAMIENTA_COMPLETAR],
      tool_choice: { type: 'tool', name: 'completar_factura' },
    });
  } catch (err) {
    const e = err as { status?: number; error?: { error?: { type?: string } } };
    logger.warn('[ocr-claude] El complemento con Claude ha fallado', { http: e.status ?? null, tipo: e.error?.error?.type ?? null });
    return { tipo: 'sin_complemento', lectura: sinComplemento(l, preguntas) };
  }
  const uso = (respuesta?.content ?? []).find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
  if (!uso) return { tipo: 'sin_complemento', lectura: sinComplemento(l, preguntas) };
  return { tipo: 'completada', lectura: mezclarComplemento(l, uso.input as Record<string, unknown>, ctx) };
}
