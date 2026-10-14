/**
 * Lector de ventas: terminar a mano lo que no se ha leido bien
 * (C:/tmp/conta-specs/lector-editable.md). Funciones puras, sin BD:
 *
 *  - leerCorrecciones: el bloque `correcciones` de /ingresos-extractor/confirmar,
 *    con su forma comprobada (400 con el campo «correcciones.x»).
 *  - aplicarCorrecciones: la lectura guardada mas lo corregido (fuente
 *    'manual'), con el desglose, la retencion y los totales recalculados y el
 *    QR VERI*FACTU cotejado otra vez con lo nuevo. Despues se valida como una
 *    lectura (validarLectura): los errores que ya no aplican dejan de bloquear.
 *  - cuotasFijasPorTipo: la cuota de IVA de cada tipo sobre la suma de sus
 *    bases, repartida al centimo entre sus lineas (dos lineas al 21 % a la 700 y
 *    a la 705 cuadran con la factura). La pantalla hace el mismo reparto.
 *  - campoDeCorreccion: de un campo de la lectura (numero, desglose.0.base...)
 *    al campo de la correccion que hay que tocar, para senalarlo en la pantalla.
 *  - cambiosCorregidos: lo leido y lo puesto, para el AuditLog.
 */
import { repartirCentimos } from '../../domain/importesFactura';
import { esFechaReal } from '../../schemas/factura-gasto.schemas';
import { aCentimos, redondear2 } from '../../utils/money';
import { badRequest } from '../../utils/http-errors';
import type { Campo, CampoId, LecturaNormalizada, QrInterpretado, ResultadoQr } from './tipos';
import { compararQr } from './verifactu-qr';

/** Una linea de la factura tal como la deja la persona. */
export interface LineaCorregida {
  /** Vacia: la del concepto de la factura (o una generica). */
  descripcion: string;
  /** Base imponible de la linea, con su signo (en negativo solo en una rectificativa). */
  base: number;
  tipoIva: number;
  /** Cuenta de ingresos; sin ella, la de por defecto (o la de la original en una rectificativa). */
  cuenta?: string | null;
}

/** Lo que se corrige de una venta leida. Lo que no llega se queda como se leyo. */
export interface CorreccionesVenta {
  /** Tal como aparece en la factura («F2026/0012»). */
  numero?: string;
  fechaEmision?: string;
  /** null: la de por defecto. */
  fechaVencimiento?: string | null;
  concepto?: string | null;
  /** La lista COMPLETA de lineas. */
  lineas?: LineaCorregida[];
  /** Una sola retencion para toda la factura, como hoy, en entero (0: sin retencion). */
  tipoRetencion?: number;
  /** Total a cobrar: obligatorio si se corrigen las lineas o la retencion. */
  total?: number;
}

/** Tipos de IVA que se pueden poner en una venta leida (los del lector). */
export const TIPOS_IVA_CORRECCION = [0, 4, 5, 10, 21];
const CLAVES = new Set(['numero', 'fechaEmision', 'fechaVencimiento', 'concepto', 'lineas', 'tipoRetencion', 'total']);
const MAX_LINEAS = 50;
const MAX_IMPORTE = 1e10;

const noValida = (mensaje: string, campo: string) => badRequest(mensaje, { codigo: 'CORRECCION_NO_VALIDA', campo });

/** Un importe con dos decimales como mucho y dentro de lo razonable. */
const esImporte = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && Math.abs(x) <= MAX_IMPORTE && Math.abs(x * 100 - Math.round(x * 100)) < 1e-6;
const vacio = (x: unknown) => x === undefined || x === null;

/**
 * Lee el bloque `correcciones` del cuerpo. null si no llega o llega vacio.
 * `rectificativa`: la lectura es una rectificativa o un abono (V19 o importes
 * leidos en negativo); solo entonces se admiten bases en negativo.
 * `espanola`: una empresa de fuera de Espana no repercute IVA espanol.
 */
export function leerCorrecciones(raw: unknown, opciones: { espanola: boolean; rectificativa: boolean }): CorreccionesVenta | null {
  if (vacio(raw)) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw noValida('Los datos corregidos no tienen el formato esperado.', 'correcciones');
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(r)) if (!CLAVES.has(k)) throw noValida(`No se reconoce el dato «${k}» de la corrección.`, `correcciones.${k}`);
  const c: CorreccionesVenta = {};

  if (r.numero !== undefined) {
    const n = typeof r.numero === 'string' ? r.numero.trim() : '';
    if (!n || n.length > 60) throw noValida('Escribe el número de la factura tal como aparece en ella (60 caracteres como mucho).', 'correcciones.numero');
    c.numero = n;
  }
  if (r.fechaEmision !== undefined) {
    if (typeof r.fechaEmision !== 'string' || !esFechaReal(r.fechaEmision)) throw noValida('La fecha de la factura no es válida.', 'correcciones.fechaEmision');
    c.fechaEmision = r.fechaEmision;
  }
  if (r.fechaVencimiento !== undefined) {
    if (r.fechaVencimiento !== null && (typeof r.fechaVencimiento !== 'string' || !esFechaReal(r.fechaVencimiento))) {
      throw noValida('La fecha de vencimiento no es válida.', 'correcciones.fechaVencimiento');
    }
    c.fechaVencimiento = r.fechaVencimiento as string | null;
  }
  if (r.concepto !== undefined) {
    if (r.concepto !== null && typeof r.concepto !== 'string') throw noValida('El concepto no es válido.', 'correcciones.concepto');
    const t = typeof r.concepto === 'string' ? r.concepto.replace(/\s+/g, ' ').trim() : '';
    if (t.length > 500) throw noValida('El concepto no puede pasar de 500 caracteres.', 'correcciones.concepto');
    c.concepto = t || null;
  }
  if (r.lineas !== undefined) c.lineas = leerLineas(r.lineas, opciones);
  if (r.tipoRetencion !== undefined) {
    const t = r.tipoRetencion;
    // Entero: la linea de la factura guarda el porcentaje sin decimales (tipoRetencion es Int).
    if (typeof t !== 'number' || !Number.isInteger(t) || t < 0 || t > 50) {
      throw noValida('La retención tiene que ser un porcentaje sin decimales entre 0 y 50 (por ejemplo, 15).', 'correcciones.tipoRetencion');
    }
    c.tipoRetencion = t;
  }
  if (r.total !== undefined) {
    if (!esImporte(r.total)) throw noValida('El total tiene que ser un importe con dos decimales como mucho.', 'correcciones.total');
    c.total = r.total;
  }
  if ((c.lineas !== undefined || c.tipoRetencion !== undefined) && c.total === undefined) {
    throw badRequest('Escribe el total de la factura: con él se comprueba que las líneas cuadran.', { codigo: 'FALTA_TOTAL', campo: 'correcciones.total' });
  }
  return Object.keys(c).length ? c : null;
}

function leerLineas(raw: unknown, opciones: { espanola: boolean; rectificativa: boolean }): LineaCorregida[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_LINEAS) {
    throw noValida(`Pon entre 1 y ${MAX_LINEAS} líneas.`, 'correcciones.lineas');
  }
  return raw.map((x, i) => {
    const campo = `correcciones.lineas.${i}`;
    const n = `Línea ${i + 1}`;
    if (!x || typeof x !== 'object' || Array.isArray(x)) throw noValida(`${n}: no tiene el formato esperado.`, campo);
    const l = x as Record<string, unknown>;
    if (!vacio(l.descripcion) && typeof l.descripcion !== 'string') throw noValida(`${n}: la descripción no es válida.`, `${campo}.descripcion`);
    const descripcion = typeof l.descripcion === 'string' ? l.descripcion.replace(/\s+/g, ' ').trim() : '';
    if (descripcion.length > 500) throw noValida(`${n}: la descripción no puede pasar de 500 caracteres.`, `${campo}.descripcion`);
    if (!esImporte(l.base)) throw noValida(`${n}: la base tiene que ser un importe con dos decimales como mucho.`, `${campo}.base`);
    if (typeof l.tipoIva !== 'number' || !TIPOS_IVA_CORRECCION.includes(l.tipoIva)) {
      throw noValida(`${n}: el IVA tiene que ser del 21, 10, 5 o 4 %, o exento.`, `${campo}.tipoIva`);
    }
    if (l.base < 0 && !opciones.rectificativa) {
      throw badRequest(
        `${n}: la base está en negativo y la factura leída no es una rectificativa. Si es un abono, créalo en Ventas → Nueva factura → «Rectificativa o abono».`,
        { codigo: 'IMPORTE_NEGATIVO', campo: `${campo}.base` },
      );
    }
    if (l.tipoIva !== 0 && !opciones.espanola) {
      throw badRequest(`${n}: tu empresa no está establecida en España y sus ventas no llevan IVA español. Pon el IVA a 0 %.`, {
        codigo: 'SIN_IVA_ESPANOL',
        campo: `${campo}.tipoIva`,
      });
    }
    let cuenta: string | null = null;
    if (!vacio(l.cuenta)) {
      if (typeof l.cuenta !== 'string' || l.cuenta.length > 20) throw noValida(`${n}: la cuenta de ingresos no es válida.`, `${campo}.cuenta`);
      cuenta = l.cuenta.replace(/[\s.]/g, '') || null;
    }
    return { descripcion, base: l.base, tipoIva: l.tipoIva, cuenta };
  });
}

// ---------------------------------------------------------------------------
// Cuotas y totales
// ---------------------------------------------------------------------------

const sumaCentimos = (xs: number[]) => xs.reduce((a, x) => a + aCentimos(x), 0) / 100;

/**
 * Cuota de IVA de cada linea: la del tipo se calcula sobre la suma de las
 * bases de ese tipo y se reparte al centimo entre sus lineas (repartirCentimos,
 * por el mayor resto). Con una sola linea por tipo es la de siempre. Con todas
 * las bases del tipo en negativo (una rectificativa), el reparto se hace en
 * positivo y se le cambia el signo: así el abono es el espejo de la factura.
 */
export function cuotasFijasPorTipo(lineas: Array<{ base: number; tipoIva: number }>): number[] {
  const cuotas = new Array<number>(lineas.length).fill(0);
  const tipos = new Map<number, number[]>();
  lineas.forEach((l, i) => tipos.set(l.tipoIva, [...(tipos.get(l.tipoIva) ?? []), i]));
  for (const [t, idx] of tipos) {
    if (t === 0) continue;
    const negativo = idx.every((i) => aCentimos(lineas[i].base) <= 0) && idx.some((i) => aCentimos(lineas[i].base) < 0);
    const s = negativo ? -1 : 1;
    const bases = idx.map((i) => s * lineas[i].base);
    const reparto = repartirCentimos(redondear2((sumaCentimos(bases) * t) / 100), bases.map((b) => (b * t) / 100));
    idx.forEach((i, k) => (cuotas[i] = s * reparto[k] || 0));
  }
  return cuotas;
}

/** Retencion de unas bases, linea a linea (como el alta de la factura). */
const retencionDe = (bases: number[], tipo: number) => sumaCentimos(bases.map((b) => redondear2((b * tipo) / 100)));

/**
 * Porcentaje de la retencion leida. Si solo se leyo el importe (la IA puede
 * no ver el porcentaje), el que sale de importe / bases, en entero, como hace
 * el lector de gastos (y la pantalla del lector de ventas). 0 sin retencion.
 * Sin esto, la retencion se perdia al registrar y no cuadraba nunca.
 */
export function tipoRetencionLeido(l: LecturaNormalizada): number {
  const tipo = l.retencion?.tipo.valor;
  if (typeof tipo === 'number' && Number.isFinite(tipo) && tipo > 0) return tipo;
  const importe = Math.abs(l.retencion?.importe.valor ?? 0);
  const base = Math.abs(sumaCentimos(l.desglose.map((t) => t.base.valor ?? 0)));
  return importe > 0 && base > 0 ? Math.round((importe / base) * 100) : 0;
}

const manual = <T>(valor: T | null): Campo<T> => ({ valor, confianza: null, fuente: 'manual' });
const calculado = <T>(valor: T | null): Campo<T> => ({ valor, confianza: null, fuente: 'calculado' });

/** El QR tal como se leyo (sin comparar), para volver a cotejarlo con lo corregido. null si no habia uno de la AEAT. */
export function qrInterpretadoDe(qr: ResultadoQr | null | undefined): QrInterpretado | null {
  if (!qr || qr.estado === 'SIN_QR') return null;
  if (qr.estado === 'AJENO') return { estado: 'AJENO', verifactu: null, datos: null };
  if (qr.pruebas) return { estado: 'PRUEBAS', verifactu: null, datos: null };
  if (qr.datos) return { estado: 'VALIDO', verifactu: qr.verifactu, datos: qr.datos };
  return { estado: 'ILEGIBLE', verifactu: qr.verifactu, datos: null };
}

/**
 * La lectura guardada con lo corregido. Lo que no se corrige se queda como se
 * leyo (con su confianza). Si se corrigen las lineas: un tramo por tipo de IVA
 * con la suma de sus bases y su cuota (cuotasFijasPorTipo), sin recargo. Si se
 * corrigen las lineas o la retencion, la retencion se recalcula. El total de la
 * factura se calcula (base + IVA + recargo) y el total a cobrar es el escrito.
 * Por ultimo, el QR VERI*FACTU (si lo habia) se coteja otra vez: si lo
 * corregido lo contradice, es un error (el QR manda).
 */
export function aplicarCorrecciones(leida: LecturaNormalizada, c: CorreccionesVenta): LecturaNormalizada {
  const l: LecturaNormalizada = structuredClone(leida);
  if (c.numero !== undefined) l.numero = manual(c.numero);
  if (c.fechaEmision !== undefined) l.fechaEmision = manual(c.fechaEmision);
  if (c.fechaVencimiento !== undefined) l.fechaVencimiento = manual(c.fechaVencimiento);
  if (c.concepto !== undefined) l.concepto = manual(c.concepto);

  if (c.lineas) {
    const cuotas = cuotasFijasPorTipo(c.lineas);
    const tipos = [...new Set(c.lineas.map((x) => x.tipoIva))];
    l.desglose = tipos.map((t) => {
      const idx = c.lineas!.map((x, i) => (x.tipoIva === t ? i : -1)).filter((i) => i >= 0);
      return {
        tipoIva: t,
        base: manual(sumaCentimos(idx.map((i) => c.lineas![i].base))),
        cuota: calculado(sumaCentimos(idx.map((i) => cuotas[i]))),
        tipoRecargo: null,
        cuotaRecargo: null,
      };
    });
    l.lineas = c.lineas.map((x) => ({ descripcion: x.descripcion || null, cantidad: 1, precioUnitario: x.base, importe: x.base, tipoIva: x.tipoIva, confianza: null }));
  }

  if (c.lineas !== undefined || c.tipoRetencion !== undefined) {
    // Sin porcentaje corregido, el leido (o el que sale del importe leido sobre las bases leidas).
    const tipo = c.tipoRetencion ?? tipoRetencionLeido(leida);
    const bases = c.lineas ? c.lineas.map((x) => x.base) : l.desglose.map((t) => t.base.valor ?? 0);
    const importe = retencionDe(bases, tipo);
    if (aCentimos(importe) !== 0 || (c.tipoRetencion ?? 0) > 0) {
      const tipoLeido = l.retencion && (l.retencion.tipo.valor ?? 0) > 0 ? l.retencion.tipo : null;
      l.retencion = { tipo: c.tipoRetencion !== undefined ? manual(c.tipoRetencion) : (tipoLeido ?? calculado(tipo)), importe: calculado(importe) };
      l.totales.retencion = calculado(importe);
    } else {
      l.retencion = null;
      l.totales.retencion = calculado(0);
    }
  }

  if (c.lineas !== undefined || c.tipoRetencion !== undefined || c.total !== undefined) {
    const base = sumaCentimos(l.desglose.map((t) => t.base.valor ?? 0));
    const iva = sumaCentimos(l.desglose.map((t) => t.cuota.valor ?? 0));
    const recargo = sumaCentimos(l.desglose.map((t) => t.cuotaRecargo?.valor ?? 0));
    const retencion = l.retencion?.importe.valor ?? l.totales.retencion.valor ?? 0;
    const bruto = sumaCentimos([base, iva, recargo]);
    l.totales.base = calculado(base);
    l.totales.cuotaIva = calculado(iva);
    l.totales.cuotaRecargo = calculado(recargo);
    l.totales.totalFactura = calculado(bruto);
    l.totales.totalAPagar = c.total !== undefined ? manual(c.total) : calculado(sumaCentimos([bruto, -retencion]));
  }

  return leida.qr ? compararQr(qrInterpretadoDe(leida.qr), l) : l;
}

// ---------------------------------------------------------------------------
// Campos y cambios
// ---------------------------------------------------------------------------

/**
 * El campo de la correccion que corresponde a un campo de la lectura, para
 * los 400 (details.campo). Un tramo de IVA lleva a la primera linea corregida
 * de ese tipo (su IVA si la validacion es del tipo; si no, su base); sin
 * lineas corregidas, a las lineas. El NIF del cliente, a elegir el cliente.
 * El emisor, la moneda y el tipo de documento no se corrigen: null.
 */
export function campoDeCorreccion(id: CampoId | string | undefined, c: CorreccionesVenta | null, lc: LecturaNormalizada, codigo?: string): string | null {
  if (!id) return null;
  if (id === 'numero' || id === 'fechaEmision' || id === 'fechaVencimiento' || id === 'concepto') return `correcciones.${id}`;
  const tramo = /^desglose\.(\d+)\./.exec(id);
  if (tramo) {
    const t = lc.desglose[Number(tramo[1])]?.tipoIva;
    const i = c?.lineas ? c.lineas.findIndex((x) => x.tipoIva === t) : -1;
    if (i < 0) return 'correcciones.lineas';
    return `correcciones.lineas.${i}.${codigo === 'TIPO_IVA' ? 'tipoIva' : 'base'}`;
  }
  if (id.startsWith('retencion.')) return 'correcciones.tipoRetencion';
  if (id.startsWith('totales.')) return 'correcciones.total';
  if (id.startsWith('receptor.')) return 'clienteId';
  return null;
}

export interface CambioCorregido {
  campo: string;
  leido: unknown;
  puesto: unknown;
}

/**
 * Lo que se ha cambiado a mano, con el valor leido y el puesto, para el
 * AuditLog. `leida` null: rellenada a mano (no habia nada leido). Las cuentas
 * no cuentan como correccion (eso es «Cambiar cuenta»).
 */
export function cambiosCorregidos(leida: LecturaNormalizada | null, c: CorreccionesVenta): CambioCorregido[] {
  const cambios: CambioCorregido[] = [];
  const anotar = (campo: string, leido: unknown, puesto: unknown) => {
    if (JSON.stringify(leido ?? null) !== JSON.stringify(puesto ?? null)) cambios.push({ campo, leido: leido ?? null, puesto: puesto ?? null });
  };
  if (c.numero !== undefined) anotar('numero', leida?.numero.valor, c.numero);
  if (c.fechaEmision !== undefined) anotar('fechaEmision', leida?.fechaEmision.valor, c.fechaEmision);
  if (c.fechaVencimiento !== undefined) anotar('fechaVencimiento', leida?.fechaVencimiento.valor, c.fechaVencimiento);
  if (c.concepto !== undefined) anotar('concepto', leida?.concepto.valor, c.concepto);
  if (c.lineas !== undefined) {
    anotar(
      'lineas',
      // Con el recargo leido, si lo habia: al corregir las lineas se registra sin el (nadie vende en recargo, 11-10-2026).
      leida ? leida.desglose.map((t) => ({ tipoIva: t.tipoIva, base: t.base.valor, cuota: t.cuota.valor, ...(t.cuotaRecargo?.valor ? { recargo: t.cuotaRecargo.valor } : {}) })) : null,
      c.lineas.map((x) => ({ descripcion: x.descripcion, base: x.base, tipoIva: x.tipoIva })),
    );
  }
  if (c.tipoRetencion !== undefined) anotar('tipoRetencion', leida ? (leida.retencion?.tipo.valor ?? 0) : null, c.tipoRetencion);
  if (c.total !== undefined) anotar('total', leida?.totales.totalAPagar.valor, c.total);
  return cambios;
}

/** Nombres de lo corregido para las observaciones de la factura: «número, fecha y líneas». */
export function textoCorregidos(c: CorreccionesVenta): string {
  const nombres: Array<[keyof CorreccionesVenta, string]> = [
    ['numero', 'número'],
    ['fechaEmision', 'fecha'],
    ['fechaVencimiento', 'vencimiento'],
    ['concepto', 'concepto'],
    ['lineas', 'líneas'],
    ['tipoRetencion', 'retención'],
    ['total', 'total'],
  ];
  const t = nombres.filter(([k]) => c[k] !== undefined).map(([, n]) => n);
  return t.length > 1 ? `${t.slice(0, -1).join(', ')} y ${t[t.length - 1]}` : (t[0] ?? '');
}
