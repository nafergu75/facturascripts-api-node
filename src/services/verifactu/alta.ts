/**
 * Registro de alta de VERI*FACTU a partir de una factura ya numerada (spec
 * verifactu, 3.3, 3.4 y 4). Puro: sin BD. Lo usa generarRegistroAlta dentro de
 * la transaccion que numera la factura.
 *
 *  - construirAlta: los textos exactos del registro (formato.ts), el desglose
 *    agrupado por clave de regimen, calificacion o exencion y tipo, los
 *    destinatarios y las facturas rectificadas.
 *  - validarAlta: lo que la AEAT rechazaria (Validaciones y errores v1.2.2, de
 *    08/04/2026, apdos. 3.1.3 y 15). Un fallo es un 422 con details.codigo
 *    VERIFACTU_* y deshace la transaccion: ni numero gastado ni cadena a medias.
 *  - problemaDestinatario: la misma comprobacion del destinatario, para decirlo
 *    antes de abrir la transaccion.
 *
 * Importes: en centimos enteros, de las columnas de CUENTA de las lineas (en
 * euros en una empresa espanola: el XSD no tiene campo de moneda). Nunca se
 * suman floats.
 *
 * Suplidos (FAQ de desarrolladores v1.3, n.º 21 y 22): en una factura NACIONAL
 * las lineas al 0 % son suplidos (gastos pagados en nombre del cliente): no van
 * al desglose ni al ImporteTotal. El IRPF tampoco (FAQ n.º 20): ImporteTotal es
 * la suma de base y cuota del desglose.
 */
import { badRequest, internalError, unprocessable } from '../../utils/http-errors';
import { aCentimos } from '../../utils/money';
import { hoyEspana } from '../../utils/fechas';
import { normalizarNif, validarNifEspanol } from '../../utils/nif';
import {
  desgloseVerifactu,
  destinatarioVerifactu,
  limpiarNif,
  paisDelCliente,
  type ClienteFiscal,
  type TipoOperacionVenta,
} from '../../domain/tipo-operacion.model';
import { cabeEnImporte, esFechaIso, fechaAeat, formatearImporte, formatearTipo } from './formato';
import { PAISES_AEAT, problemaNifIvaAeat } from './paises';
import type {
  AltaConstruida,
  CalificacionOperacion,
  ClaveRegimen,
  CuerpoAlta,
  Destinatario,
  DetalleDesglose,
  FacturaRectificadaRef,
  OperacionExenta,
  ProblemaDestinatario,
} from './tipos';

/** Linea de la factura en la moneda de cuenta (EUR). */
export interface LineaAlta {
  descripcion: string;
  baseLine: number;
  ivaImporte: number;
  tipoIva: number;
}

/** Lo que se rectifica, tal como esta en los enlaces de la rectificativa. */
export type RectificadaAlta =
  | {
      tipo: 'APP';
      numeroCompleto: string | null;
      fechaEmision: string;
      /** Tipo de operacion con el que se trata la original. */
      tipoOperacion: TipoOperacionVenta | null;
      lineas: LineaAlta[];
      /** Desglose de su registro de alta, si lo tiene. */
      desgloseRegistro: DetalleDesglose[] | null;
    }
  | { tipo: 'FUERA'; numero: string | null; fecha: string | null }
  | { tipo: 'PERIODO' };

/** La factura emitida, ya numerada, y lo que hace falta para su registro. */
export interface EntradaAlta {
  facturaId: string;
  tipoFactura: string;
  tipoRectificativa: string | null;
  numeroCompleto: string;
  /** AAAA-MM-DD */
  fechaEmision: string;
  fechaOperacion: string | null;
  /** Tipo de operacion efectivo (operacionEfectiva con paisClienteLegacy si no tiene). */
  tipoOperacion: TipoOperacionVenta;
  causaExencion: string | null;
  descripcionOperacion: string | null;
  motivoRectificacion: string | null;
  /** Totales de la factura en la moneda de cuenta: la comprobacion interna del desglose. */
  baseTotal: number;
  ivaTotal: number;
  lineas: LineaAlta[];
  /** Emisor y cliente de la instantanea de la emision. */
  emisor: { nombre: string };
  cliente: ClienteFiscal & { nombre: string };
  /** VerifactuConfig.nifObligado (congelado): IDEmisorFactura. */
  nifObligado: string;
  /** AjustesFiscales.criterioCaja: clave 07 en las nacionales. */
  criterioCaja: boolean;
  rectificadas: RectificadaAlta[];
}

const TIPOS_RECTIFICATIVA = ['R1', 'R2', 'R3', 'R4', 'R5'];
const SIN_DESTINATARIO = ['F2', 'R5'];
const MACRODATO_CENTIMOS = 100_000_000_00;
const LIMITE_F2_CENTIMOS = 3_010_00;
const MAX_DESCRIPCION = 500;
const MAX_NOMBRE = 120;
const MAX_ID_OTRO = 20;

/** Texto con como mucho `n` caracteres (puntos de codigo, como cuenta el XSD). */
const recortar = (texto: string, n: number): string => Array.from(texto).slice(0, n).join('');
const largo = (texto: string): number => Array.from(texto).length;

/**
 * Por que NumSerieFactura no vale para la AEAT, o null: 1-60 caracteres ASCII
 * imprimibles (32-126), sin " ' < > = (Validaciones 3.1.3.1). La app prohibe
 * ademas el & (spec 3.5: no se sabe si la huella usaria & o &amp;).
 */
export function problemaNumSerie(numSerie: string | null | undefined): string | null {
  const n = String(numSerie ?? '');
  if (!n.trim()) return 'está vacío';
  if (n.length > 60) return 'tiene más de 60 caracteres';
  for (const ch of n) {
    const c = ch.charCodeAt(0);
    if (ch.length > 1 || c < 32 || c > 126) return `lleva un carácter que la AEAT no admite («${ch}»)`;
    if (`"'<>=&`.includes(ch)) return `lleva el carácter «${ch}», que la AEAT no admite`;
  }
  return null;
}

const error422 = (codigo: string, mensaje: string, extra: Record<string, unknown> = {}) => unprocessable(mensaje, { codigo, code: codigo, ...extra });

/**
 * Destinatario requerido y no identificable (comprobacion previa, sin BD). En
 * F2 y R5 no hay destinatario: null. Cliente de España: NIF español valido.
 * Extranjero (IDOtro): alguna identificacion de como mucho 20 caracteres; con
 * NIF-IVA (IDType 02), con la estructura de su Estado; con otro documento (04),
 * con un pais de la lista del XSD. Una R2 solo admite NIF, NIF-IVA o «no
 * censado» (error 1192).
 */
export function problemaDestinatario(tipoFactura: string, cliente: ClienteFiscal): ProblemaDestinatario | null {
  if (SIN_DESTINATARIO.includes(tipoFactura)) return null;
  const pais = paisDelCliente(cliente);
  if (pais === 'ES') {
    if (validarNifEspanol(cliente.nifCif).valido) return null;
    return {
      codigo: 'VERIFACTU_CLIENTE_SIN_NIF',
      mensaje:
        tipoFactura === 'F1'
          ? 'El cliente necesita un NIF válido para una factura completa. Corrígelo en su ficha o, si no pasa de 3.000 €, emítela como simplificada.'
          : 'El cliente necesita un NIF válido para emitir la rectificativa. Corrígelo en su ficha y vuelve a emitirla.',
    };
  }
  const id = limpiarNif(cliente.nifCif);
  if (!id) {
    return {
      codigo: 'VERIFACTU_CLIENTE_SIN_IDENTIFICACION',
      mensaje: 'El cliente extranjero no tiene número de identificación fiscal en su ficha y VERI*FACTU lo exige en una factura completa. Añádelo en la ficha del cliente.',
    };
  }
  if (id.length > MAX_ID_OTRO) {
    return {
      codigo: 'VERIFACTU_ID_DESTINATARIO_LARGO',
      mensaje: `El número de identificación del cliente tiene ${id.length} caracteres y la AEAT admite 20 como mucho. Revísalo en la ficha del cliente.`,
    };
  }
  const d = destinatarioVerifactu(cliente);
  const idType = 'idOtro' in d ? d.idOtro.idType : null;
  if (idType === '02') {
    const p = problemaNifIvaAeat(id);
    if (p) {
      return {
        codigo: 'VERIFACTU_NIF_IVA',
        mensaje: `El NIF-IVA del cliente (${id}) no tiene la forma que exige la AEAT: ${p}. Revísalo en la ficha del cliente (se puede comprobar en VIES).`,
      };
    }
  } else if (!PAISES_AEAT.has(pais)) {
    return {
      codigo: 'VERIFACTU_PAIS_CLIENTE',
      mensaje: /^[A-Z]{2}$/.test(pais)
        ? `La AEAT no admite «${pais}» como país del cliente: no está en su lista de países. Revisa el país en la ficha del cliente.`
        : 'El país del cliente no es un código de país válido (dos letras, como FR o US). Corrígelo en su ficha.',
    };
  }
  if (tipoFactura === 'R2' && idType === '04') {
    return {
      codigo: 'VERIFACTU_R2_DESTINATARIO',
      mensaje:
        'Una rectificativa por concurso del cliente (R2) solo admite un cliente identificado con NIF español o con NIF-IVA de otro país de la UE. ' +
        'Este cliente tiene otro documento: revisa su ficha o usa otro motivo de rectificación.',
    };
  }
  return null;
}

/** Destinatario del registro (sin comprobar: problemaDestinatario lo hace aparte). */
function destinatarioDe(cliente: ClienteFiscal & { nombre: string }): Destinatario {
  const nombre = recortar(String(cliente.nombre ?? '').trim(), MAX_NOMBRE);
  const d = destinatarioVerifactu(cliente);
  if ('nif' in d) return { nombre, nif: normalizarNif(cliente.nifCif) };
  // Con IDType 02 (NIF-IVA) sin CodigoPais: ver destinatarioVerifactu.
  const { codigoPais, idType, id } = d.idOtro;
  return { nombre, idOtro: codigoPais ? { codigoPais, idType, id } : { idType, id } };
}

/** Calificacion y exencion de la app (VerifactuOperacion) con los tipos del registro. */
interface Operacion {
  claveRegimen: ClaveRegimen;
  calificacion: CalificacionOperacion | null;
  exenta: OperacionExenta | null;
  tipoYCuotaCero: boolean;
}

function operacionDe(tipo: TipoOperacionVenta, cliente: ClienteFiscal, causaExencion: string | null, criterioCaja: boolean): Operacion {
  const vf = desgloseVerifactu(tipo, { cliente, causaExencion, criterioCaja });
  if (!vf) throw internalError(`El tipo de operación ${tipo} no genera registro de VERI*FACTU.`, { codigo: 'VERIFACTU_SIN_REGISTRO' });
  return {
    claveRegimen: vf.claveRegimen,
    calificacion: vf.calificacion,
    exenta: vf.operacionExenta,
    tipoYCuotaCero: vf.tipoYCuotaCero,
  };
}

/** Linea de suplido: al 0 % en una factura nacional (la app solo admite ahi el 0 % para suplidos). */
const esSuplido = (tipo: TipoOperacionVenta | null, l: LineaAlta) => tipo === 'NACIONAL' && Number(l.tipoIva) === 0;

interface GrupoDesglose {
  op: Operacion;
  tipoIva: number | null;
  base: number;
  cuota: number;
}

/** Lineas del desglose agrupadas (en centimos), sin suplidos. */
function agrupar(tipo: TipoOperacionVenta, op: Operacion, lineas: LineaAlta[]): { grupos: GrupoDesglose[]; baseSuplidos: number } {
  const grupos = new Map<string, GrupoDesglose>();
  let baseSuplidos = 0;
  for (const l of lineas) {
    if (esSuplido(tipo, l)) {
      baseSuplidos += aCentimos(Number(l.baseLine));
      continue;
    }
    // Solo S1 lleva cuota: una exenta, no sujeta o con inversion del sujeto pasivo con IVA no se puede registrar.
    if (op.calificacion !== 'S1' && aCentimos(Number(l.ivaImporte)) !== 0) {
      throw error422(
        'VERIFACTU_IVA_EN_OPERACION_SIN_IVA',
        'La factura lleva IVA en una línea, pero su tipo de operación no lo lleva (exenta, no sujeta, exportación, intracomunitaria o inversión del sujeto pasivo). Corrige el IVA de las líneas o el tipo de operación.',
      );
    }
    const conTipo = op.calificacion === 'S1' || op.calificacion === 'S2';
    const tipoIva = op.calificacion === 'S1' ? Number(l.tipoIva) : op.calificacion === 'S2' ? 0 : null;
    const clave = `${op.claveRegimen}|${op.calificacion ?? op.exenta}|${conTipo ? tipoIva : '-'}`;
    const g = grupos.get(clave) ?? { op, tipoIva, base: 0, cuota: 0 };
    g.base += aCentimos(Number(l.baseLine));
    g.cuota += aCentimos(Number(l.ivaImporte));
    grupos.set(clave, g);
  }
  return { grupos: [...grupos.values()], baseSuplidos };
}

/** Importe en centimos -> texto de la AEAT; 422 si pasa de 12 cifras enteras. */
function importe(c: number): string {
  if (!cabeEnImporte(c)) {
    throw error422('VERIFACTU_IMPORTE_GRANDE', 'La factura tiene un importe de más de 12 cifras y la AEAT no lo admite. Divídela en varias facturas.');
  }
  return formatearImporte(c);
}

function detalle(g: GrupoDesglose): DetalleDesglose {
  const d: DetalleDesglose = { impuesto: '01', claveRegimen: g.op.claveRegimen, baseImponible: importe(g.base) };
  if (g.op.calificacion) d.calificacionOperacion = g.op.calificacion;
  else if (g.op.exenta) d.operacionExenta = g.op.exenta;
  if (g.op.calificacion === 'S1') {
    d.tipoImpositivo = formatearTipo(g.tipoIva ?? 0);
    d.cuotaRepercutida = importe(g.cuota);
  } else if (g.op.calificacion === 'S2') {
    d.tipoImpositivo = '0.00';
    d.cuotaRepercutida = '0.00';
  }
  return d;
}

/** Centimos de un texto de importe del registro («-123.40» -> -12340). */
export const centimosDeTexto = (t: string | undefined | null): number => (t ? aCentimos(Number(t)) : 0);

/** Base y cuota (centimos) de un desglose ya guardado. */
export function sumaDesglose(desglose: DetalleDesglose[]): { base: number; cuota: number } {
  return desglose.reduce((s, d) => ({ base: s.base + centimosDeTexto(d.baseImponible), cuota: s.cuota + centimosDeTexto(d.cuotaRepercutida) }), { base: 0, cuota: 0 });
}

/** Base y cuota (centimos) de una original de la app: las de su registro o, si no tiene, con la misma regla (sin suplidos). */
function importesDeOriginal(o: Extract<RectificadaAlta, { tipo: 'APP' }>): { base: number; cuota: number } {
  if (o.desgloseRegistro?.length) return sumaDesglose(o.desgloseRegistro);
  return o.lineas.reduce(
    (s, l) => (esSuplido(o.tipoOperacion, l) ? s : { base: s.base + aCentimos(Number(l.baseLine)), cuota: s.cuota + aCentimos(Number(l.ivaImporte)) }),
    { base: 0, cuota: 0 },
  );
}

/** DescripcionOperacion: la de la factura; si no, en una rectificativa su explicacion; si no, las lineas. Nunca vacia. */
function descripcionDe(e: EntradaAlta): string {
  const propia = String(e.descripcionOperacion ?? '').trim();
  if (propia) return recortar(propia, MAX_DESCRIPCION);
  const explicacion = String(e.motivoRectificacion ?? '').trim();
  if (TIPOS_RECTIFICATIVA.includes(e.tipoFactura) && explicacion) return recortar(`Rectificación: ${explicacion}`, MAX_DESCRIPCION);
  const lineas = e.lineas.map((l) => String(l.descripcion ?? '').trim()).filter(Boolean).join('; ');
  return recortar(lineas || (TIPOS_RECTIFICATIVA.includes(e.tipoFactura) ? 'Rectificación' : 'Venta'), MAX_DESCRIPCION);
}

/** FacturasRectificadas: las de la app y las de fuera con numero y fecha validos; las de periodo no (bloque opcional). */
function rectificadasDe(e: EntradaAlta, avisos: string[]): FacturaRectificadaRef[] {
  const out: FacturaRectificadaRef[] = [];
  for (const r of e.rectificadas) {
    if (r.tipo === 'PERIODO') continue;
    const numero = r.tipo === 'APP' ? r.numeroCompleto : r.numero;
    const fecha = r.tipo === 'APP' ? r.fechaEmision : r.fecha;
    const problema = problemaNumSerie(numero);
    if (problema || !fecha || !esFechaIso(fecha)) {
      avisos.push(`La factura rectificada ${numero ?? ''} no se cita en el registro: su número ${problema ?? 'no tiene fecha válida'}.`);
      continue;
    }
    out.push({ idEmisor: e.nifObligado, numSerie: String(numero).trim(), fecha: fechaAeat(fecha) });
  }
  return out.slice(0, 1000);
}

/**
 * Construye el alta (textos exactos) de una factura emitida. Comprueba que el
 * desglose cuadra con los totales de la factura: si no, error interno (500) y
 * la transaccion se deshace.
 */
export function construirAlta(e: EntradaAlta): AltaConstruida {
  const avisos: string[] = [];
  const op = operacionDe(e.tipoOperacion, e.cliente, e.causaExencion, e.criterioCaja);
  const { grupos, baseSuplidos } = agrupar(e.tipoOperacion, op, e.lineas);

  // Comprobacion interna: el desglose mas los suplidos son la base de la factura, y su cuota la de la factura.
  const baseDesglose = grupos.reduce((s, g) => s + g.base, 0);
  const cuotaDesglose = grupos.reduce((s, g) => s + g.cuota, 0);
  if (baseDesglose + baseSuplidos !== aCentimos(Number(e.baseTotal)) || cuotaDesglose !== aCentimos(Number(e.ivaTotal))) {
    throw internalError('El desglose de VERI*FACTU no cuadra con los totales de la factura: no se ha emitido. Avisa al administrador.', {
      codigo: 'VERIFACTU_DESCUADRE',
      factura: e.facturaId,
    });
  }

  const desglose = grupos.map(detalle);
  const importeTotal = baseDesglose + cuotaDesglose;
  const rectificativa = TIPOS_RECTIFICATIVA.includes(e.tipoFactura);
  const forma = e.tipoRectificativa === 'S' || e.tipoRectificativa === 'I' ? e.tipoRectificativa : null;

  const cuerpo: CuerpoAlta = {
    refExterna: e.facturaId,
    nombreEmisor: String(e.emisor.nombre ?? '').trim(),
    descripcionOperacion: descripcionDe(e),
    desglose,
  };
  if (rectificativa && forma) cuerpo.tipoRectificativa = forma;
  if (rectificativa) {
    const refs = rectificadasDe(e, avisos);
    if (refs.length) cuerpo.facturasRectificadas = refs;
  }
  if (rectificativa && forma === 'S') {
    const original = e.rectificadas.find((r): r is Extract<RectificadaAlta, { tipo: 'APP' }> => r.tipo === 'APP');
    if (!original) {
      throw internalError('Una rectificativa por sustitución sin su factura original: no se ha emitido.', { codigo: 'VERIFACTU_SUSTITUCION_SIN_ORIGINAL', factura: e.facturaId });
    }
    const io = importesDeOriginal(original);
    cuerpo.importeRectificacion = { base: importe(io.base), cuota: importe(io.cuota) };
  }
  if (e.fechaOperacion && e.fechaOperacion !== e.fechaEmision) {
    cuerpo.fechaOperacion = esFechaIso(e.fechaOperacion) ? fechaAeat(e.fechaOperacion) : e.fechaOperacion;
  }
  if (Math.abs(importeTotal) >= MACRODATO_CENTIMOS) cuerpo.macrodato = 'S';

  let problema: ProblemaDestinatario | null = null;
  if (!SIN_DESTINATARIO.includes(e.tipoFactura)) {
    problema = problemaDestinatario(e.tipoFactura, e.cliente);
    if (!problema) {
      const nombre = String(e.cliente.nombre ?? '').trim();
      if (largo(nombre) > MAX_NOMBRE) avisos.push(`El nombre del cliente se recorta a ${MAX_NOMBRE} caracteres en el registro.`);
      cuerpo.destinatarios = [destinatarioDe(e.cliente)];
    }
  }
  if (avisos.length) cuerpo.avisos = avisos;

  return {
    idEmisor: e.nifObligado,
    numSerie: e.numeroCompleto,
    fechaExpedicion: esFechaIso(e.fechaEmision) ? fechaAeat(e.fechaEmision) : e.fechaEmision,
    tipoFactura: e.tipoFactura,
    cuotaTotal: importe(cuotaDesglose),
    importeTotal: importe(importeTotal),
    cuerpo,
    control: {
      fechaExpedicionIso: e.fechaEmision,
      fechaOperacionIso: e.fechaOperacion && e.fechaOperacion !== e.fechaEmision ? e.fechaOperacion : null,
      cuotaTotalCentimos: cuotaDesglose,
      importeTotalCentimos: importeTotal,
      tipos: grupos.map((g) => g.tipoIva),
      problemaDestinatario: problema,
    },
  };
}

// ---------------------------------------------------------------------------
// validarAlta
// ---------------------------------------------------------------------------

/** Primer dia admitido como fecha de expedicion: entrada en vigor de la Orden HAC/1177/2024 (Validaciones 3.1.3.1). */
export const FECHA_MINIMA_EXPEDICION = '2024-10-28';

/** Tipos de IVA (S1) que admite la AEAT y, los temporales, en que fechas (Validaciones 15.1). */
function tipoS1Admitido(tipo: number, fechaRef: string): boolean {
  if ([0, 4, 10, 21].includes(tipo)) return true;
  if (tipo === 5) return fechaRef >= '2022-07-01' && fechaRef <= '2024-09-30';
  if (tipo === 2 || tipo === 7.5) return fechaRef >= '2024-10-01' && fechaRef <= '2024-12-31';
  return false;
}

/** AAAA-MM-DD de hace `anios` años. */
function haceAnios(hoy: string, anios: number): string {
  return `${String(Number(hoy.slice(0, 4)) - anios).padStart(4, '0')}${hoy.slice(4)}`;
}

/**
 * Lo que la AEAT rechazaria, antes de generar la huella. Lanza un 422 con
 * details.codigo VERIFACTU_* y un texto para la persona. `ahora` fija «hoy»
 * (dia de Madrid).
 */
export function validarAlta(a: AltaConstruida, d: { nifObligado: string; ahora?: Date }): void {
  const hoy = hoyEspana(d.ahora ?? new Date());
  const c = a.cuerpo;
  const rectificativa = TIPOS_RECTIFICATIVA.includes(a.tipoFactura);

  // Emisor
  const nif = String(a.idEmisor ?? '');
  if (nif.length !== 9 || !validarNifEspanol(nif).valido || normalizarNif(nif) !== nif) {
    throw error422('VERIFACTU_NIF_EMISOR', `El NIF de tu empresa (${nif || 'vacío'}) no es válido para VERI*FACTU. Corrígelo en los datos de la empresa antes de emitir.`);
  }
  if (nif !== d.nifObligado) {
    throw error422('VERIFACTU_NIF_EMISOR', 'El NIF de la factura no es el que está dado de alta en VERI*FACTU para esta empresa.');
  }
  if (!c.nombreEmisor || largo(c.nombreEmisor) > MAX_NOMBRE) {
    throw error422(
      'VERIFACTU_NOMBRE_EMISOR',
      c.nombreEmisor
        ? `La denominación de tu empresa tiene más de ${MAX_NOMBRE} caracteres y la AEAT no la admite. Acórtala en los datos de la empresa.`
        : 'Falta la denominación de tu empresa. Rellénala en los datos de la empresa antes de emitir.',
    );
  }

  // Numero y fechas
  const problema = problemaNumSerie(a.numSerie);
  if (problema) throw error422('VERIFACTU_NUMERO_SERIE', `El número de factura «${a.numSerie}» ${problema}. Usa otra serie.`);
  const fx = a.control.fechaExpedicionIso;
  if (!esFechaIso(fx) || fx > hoy) {
    throw error422('VERIFACTU_FECHA_EXPEDICION', 'La fecha de la factura no puede ser posterior a hoy.');
  }
  if (fx < FECHA_MINIMA_EXPEDICION) {
    throw error422('VERIFACTU_FECHA_EXPEDICION', 'VERI*FACTU no admite facturas con fecha anterior al 28-10-2024.');
  }
  const fo = a.control.fechaOperacionIso;
  if (fo) {
    if (!esFechaIso(fo) || fo > fx) {
      throw error422('VERIFACTU_FECHA_OPERACION', 'La fecha de la operación no puede ser posterior a la de la factura.');
    }
    if (fo < haceAnios(hoy, 20)) {
      throw error422('VERIFACTU_FECHA_OPERACION', 'La fecha de la operación es de hace más de 20 años y la AEAT no la admite.');
    }
  }

  // Rectificativas
  if (rectificativa !== !!c.tipoRectificativa) {
    throw error422('VERIFACTU_TIPO_RECTIFICATIVA', rectificativa ? 'Falta si la rectificativa es por diferencias o por sustitución.' : 'Solo una rectificativa lleva la forma de rectificación.');
  }
  if ((c.tipoRectificativa === 'S') !== !!c.importeRectificacion) {
    throw error422('VERIFACTU_IMPORTE_RECTIFICACION', 'Una rectificativa por sustitución tiene que llevar los importes de la factura que sustituye, y solo ella.');
  }

  // Destinatarios
  if (SIN_DESTINATARIO.includes(a.tipoFactura)) {
    if (c.destinatarios?.length) {
      throw error422('VERIFACTU_DESTINATARIO_PROHIBIDO', 'Una factura simplificada (o su rectificativa) se registra sin cliente en VERI*FACTU.');
    }
  } else {
    if (a.control.problemaDestinatario) throw error422(a.control.problemaDestinatario.codigo, a.control.problemaDestinatario.mensaje);
    if (!c.destinatarios?.length) throw error422('VERIFACTU_CLIENTE_SIN_NIF', 'Falta el cliente de la factura.');
    for (const dst of c.destinatarios) {
      if (!dst.nombre) throw error422('VERIFACTU_CLIENTE_SIN_NOMBRE', 'Falta el nombre fiscal del cliente. Rellénalo en su ficha.');
      // El NIF del destinatario tiene que ser distinto del del emisor (error 1193).
      if ('nif' in dst && dst.nif === nif) {
        throw error422('VERIFACTU_CLIENTE_ES_EMISOR', `El cliente tiene el mismo NIF que tu empresa (${nif}) y la AEAT no admite una factura a uno mismo. Revisa el NIF en la ficha del cliente.`);
      }
      if ('idOtro' in dst) {
        const o = dst.idOtro;
        if (!o.id || o.id.length > MAX_ID_OTRO) {
          throw error422('VERIFACTU_CLIENTE_SIN_IDENTIFICACION', 'El número de identificación del cliente extranjero falta o pasa de 20 caracteres. Revísalo en su ficha.');
        }
        // 02: sin CodigoPais y con la estructura de su Estado (errores 1122, 1222 y 1290). Si no: pais de la lista del XSD (error 1111).
        if (o.idType === '02') {
          const p = problemaNifIvaAeat(o.id);
          if (o.codigoPais || p) throw error422('VERIFACTU_NIF_IVA', `El NIF-IVA del cliente (${o.id}) no tiene la forma que exige la AEAT${p ? `: ${p}` : ''}. Revísalo en su ficha.`);
        } else if (!o.codigoPais || !PAISES_AEAT.has(o.codigoPais)) {
          throw error422('VERIFACTU_PAIS_CLIENTE', 'El país del cliente no está en la lista de países de la AEAT. Revisa el país en su ficha.');
        }
        if (a.tipoFactura === 'R2' && o.idType !== '02' && o.idType !== '07') {
          throw error422('VERIFACTU_R2_DESTINATARIO', 'Una rectificativa por concurso del cliente (R2) solo admite un cliente con NIF español o con NIF-IVA de otro país de la UE.');
        }
      }
    }
  }

  // Desglose
  if (!c.desglose.length) {
    throw error422(
      'VERIFACTU_DESGLOSE_VACIO',
      'La factura solo tiene suplidos (líneas al 0 %) y una factura solo de suplidos no se puede emitir. Añade la operación que facturas o quita esas líneas.',
    );
  }
  if (c.desglose.length > 12) {
    throw error422('VERIFACTU_DESGLOSE_LARGO', 'La factura mezcla más de 12 combinaciones de tipo de IVA y régimen, y la AEAT admite 12 como mucho. Divídela en dos facturas.');
  }
  const fechaRefTipo = fo ?? fx;
  const sinControlCuota = c.tipoRectificativa === 'I' || a.tipoFactura === 'R2' || a.tipoFactura === 'R3';
  c.desglose.forEach((dd, i) => {
    const cal = dd.calificacionOperacion;
    const ex = dd.operacionExenta;
    if (cal === 'S1') {
      const tipo = a.control.tipos[i] ?? Number(dd.tipoImpositivo);
      if (!tipoS1Admitido(tipo, fechaRefTipo)) {
        throw error422(
          'VERIFACTU_TIPO_IMPOSITIVO',
          tipo === 5 || tipo === 2 || tipo === 7.5
            ? `El IVA del ${String(tipo).replace('.', ',')} % solo se aplicó durante un tiempo y ya no vale para esta fecha. Usa el 4, 10 o 21 %.`
            : `La AEAT no admite un IVA del ${String(tipo).replace('.', ',')} %. Usa el 4, 10 o 21 %.`,
        );
      }
      const base = centimosDeTexto(dd.baseImponible);
      const cuota = centimosDeTexto(dd.cuotaRepercutida);
      if (!sinControlCuota) {
        const esperada = (base * tipo) / 100;
        if (Math.abs(cuota - esperada) > 1000 || (cuota !== 0 && base !== 0 && Math.sign(cuota) !== Math.sign(base))) {
          throw error422('VERIFACTU_CUOTA', `La cuota de IVA al ${String(tipo).replace('.', ',')} % no cuadra con su base. Revisa los importes de las líneas.`);
        }
      }
    } else if (cal === 'S2') {
      if (dd.tipoImpositivo !== '0.00' || dd.cuotaRepercutida !== '0.00') {
        throw error422('VERIFACTU_S2', 'Con inversión del sujeto pasivo, el IVA va a cero.');
      }
      if (SIN_DESTINATARIO.includes(a.tipoFactura)) {
        throw error422('VERIFACTU_S2', 'La inversión del sujeto pasivo no admite factura simplificada. Emítela como factura completa.');
      }
    } else if (dd.tipoImpositivo !== undefined || dd.cuotaRepercutida !== undefined) {
      throw error422('VERIFACTU_DESGLOSE', 'Una operación exenta o no sujeta va sin tipo ni cuota de IVA.');
    }
    if (!cal && !ex) throw error422('VERIFACTU_DESGLOSE', 'Falta la calificación de la operación.');
    // Claves de regimen (Validaciones 15.5 y 15.6).
    const clave = dd.claveRegimen;
    if (clave === '01' && (ex === 'E2' || ex === 'E3')) {
      throw error422('VERIFACTU_CLAVE_REGIMEN', 'Una exportación o una operación asimilada (E2, E3) va con la clave 02, no con la 01.');
    }
    if (clave === '02' && !ex) throw error422('VERIFACTU_CLAVE_REGIMEN', 'La clave 02 (exportación) solo admite operaciones exentas.');
    if (clave === '07' && (cal === 'S2' || cal === 'N1' || cal === 'N2' || (ex && ['E2', 'E3', 'E4', 'E5'].includes(ex)))) {
      throw error422('VERIFACTU_CLAVE_REGIMEN', 'El criterio de caja (clave 07) no se aplica a esta operación.');
    }
    if (clave === '08' && cal !== 'N2') throw error422('VERIFACTU_CLAVE_REGIMEN', 'La clave 08 solo vale para operaciones no sujetas por localización (N2).');
    if (ex === 'E5' && !c.destinatarios?.some((x) => 'idOtro' in x)) {
      throw error422('VERIFACTU_E5_SIN_IDOTRO', 'Una entrega intracomunitaria necesita un cliente de otro país de la UE identificado con su NIF-IVA. Revisa la ficha del cliente.');
    }
  });

  // Simplificadas: base + cuota <= 3.000 € (+10 €) (Validaciones 15.8).
  if (a.tipoFactura === 'F2') {
    const total = c.desglose.reduce((s, x) => s + centimosDeTexto(x.baseImponible) + centimosDeTexto(x.cuotaRepercutida), 0);
    if (total > LIMITE_F2_CENTIMOS) {
      throw error422('VERIFACTU_F2_LIMITE', 'Una factura simplificada no puede pasar de 3.000 € (base más IVA). Emítela como factura completa.');
    }
  }

  // Descripcion
  if (!c.descripcionOperacion.trim() || largo(c.descripcionOperacion) > MAX_DESCRIPCION) {
    throw error422('VERIFACTU_DESCRIPCION', `La descripción de la operación tiene que tener entre 1 y ${MAX_DESCRIPCION} caracteres.`);
  }
  if (Math.abs(a.control.importeTotalCentimos) >= MACRODATO_CENTIMOS && c.macrodato !== 'S') {
    throw internalError('Falta la marca Macrodato en una factura de más de 100 millones.', { codigo: 'VERIFACTU_MACRODATO' });
  }
}

/** Descripcion de la operacion del cuerpo de la peticion: recortada, como mucho 500 caracteres; null si viene vacia. */
export function leerDescripcionOperacion(valor: unknown): string | null | undefined {
  if (valor === undefined) return undefined;
  if (valor === null) return null;
  if (typeof valor !== 'string') throw badRequest('La descripción de la operación tiene que ser un texto.', { campo: 'descripcionOperacion' });
  const t = valor.trim();
  if (!t) return null;
  if (largo(t) > MAX_DESCRIPCION) {
    throw badRequest(`La descripción de la operación admite como mucho ${MAX_DESCRIPCION} caracteres.`, { campo: 'descripcionOperacion' });
  }
  return t;
}
