/**
 * Plantilla B (ceramica y materiales de construccion) en las facturas de
 * venta: lectura y comprobacion de los datos de cada linea y de la factura.
 * Sin BD (las llama income-invoices.service).
 *
 * Linea (domain/ceramica): palets, cajas, m2, piezas, formato, calidad, peso,
 * unidad del precio y la marca de cargo de palets. `cantidad` es la cantidad
 * de la unidad del precio: con M2, los m2; con PIEZA o UNIDAD, las piezas (que
 * en el PDF salen en su columna). Si el dato de esa unidad no llega, se toma
 * de la cantidad; si llega distinto, 400 CANTIDAD_NO_CUADRA.
 *
 * Factura: obra y peso neto (el peso bruto ya existia por la plantilla A).
 *
 * El importe es cantidad × precio, como siempre: la base, el IVA (por tipo,
 * domain/plantillasFactura) y todo lo que cuelga de ellos salen igual que en
 * una venta normal. El cargo de palets va a su cuenta (la de la linea o, sin
 * ella, la de Configuracion > Facturacion).
 */
import { badRequest } from '../utils/http-errors';
import type { LineaEntrada } from '../domain/importesFactura';
import { admiteCeramica, type PlantillaVentaId } from '../domain/plantillasFactura';
import {
  CALIDAD_MAX,
  CAMPOS_MEDIDA,
  esUnidadPrecio,
  FORMATO_MAX,
  lineaConCeramica,
  NOMBRE_UNIDAD_PRECIO,
  OBRA_MAX,
  redondear3,
  type DatosCeramicaLinea,
  type UnidadPrecio,
} from '../domain/ceramica';

/** Mayor valor absoluto de m2, piezas o kg (las columnas son DECIMAL(14,3)). */
const MEDIDA_MAX = 99_999_999_999;
/** Mayor numero de palets o cajas (las columnas son enteros de 32 bits). */
const ENTERO_MAX = 2_000_000_000;

/** Numero del cuerpo (number o texto con punto decimal); null si no lo es. */
function numero(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v.trim());
  return null;
}

const vacio = (v: unknown) => v === undefined || v === null || v === '';
const milesimas = (v: number | null | undefined) => Math.round(Number((Number(v ?? 0) * 1000).toPrecision(15)));

const NOMBRE_CAMPO: Record<string, string> = {
  palets: 'los palets',
  cajas: 'las cajas',
  metros2: 'los m²',
  piezas: 'las piezas',
  pesoKg: 'el peso',
  formato: 'el formato',
  calidad: 'la calidad',
  unidadPrecio: 'la unidad del precio',
  cargoPalets: 'el cargo de palets',
};

/**
 * Datos de ceramica de una linea del cuerpo, con el formato comprobado (400
 * con su campo). Solo los que llegan con valor; si la plantilla los admite lo
 * decide aplicarCeramica.
 */
export function leerCeramicaLinea(l: Record<string, unknown>, i: number): DatosCeramicaLinea {
  const n = i + 1;
  const out: DatosCeramicaLinea = {};
  for (const k of ['palets', 'cajas'] as const) {
    if (vacio(l[k])) continue;
    const v = numero(l[k]);
    if (v === null || !Number.isInteger(v) || Math.abs(v) > ENTERO_MAX) {
      throw badRequest(`Línea ${n}: ${NOMBRE_CAMPO[k]} son un número entero.`, { campo: `lineas.${i}.${k}` });
    }
    out[k] = v === 0 ? 0 : v;
  }
  for (const k of ['metros2', 'piezas', 'pesoKg'] as const) {
    if (vacio(l[k])) continue;
    const v = numero(l[k]);
    if (v === null || Math.abs(v) > MEDIDA_MAX) {
      throw badRequest(`Línea ${n}: ${NOMBRE_CAMPO[k]} ${k === 'pesoKg' ? 'es' : 'son'} un número (con 3 decimales como mucho).`, { campo: `lineas.${i}.${k}` });
    }
    out[k] = redondear3(v);
  }
  for (const [k, max] of [['formato', FORMATO_MAX], ['calidad', CALIDAD_MAX]] as const) {
    if (vacio(l[k])) continue;
    if (typeof l[k] !== 'string' || String(l[k]).trim().length > max) {
      throw badRequest(`Línea ${n}: ${NOMBRE_CAMPO[k]} admite ${max} caracteres como mucho.`, { campo: `lineas.${i}.${k}` });
    }
    const t = String(l[k]).trim();
    if (t) out[k] = t;
  }
  if (!vacio(l.unidadPrecio)) {
    const u = String(l.unidadPrecio).trim().toUpperCase();
    if (!esUnidadPrecio(u)) throw badRequest(`Línea ${n}: el precio va por m², por pieza o por unidad (M2, PIEZA o UNIDAD).`, { campo: `lineas.${i}.unidadPrecio` });
    out.unidadPrecio = u;
  }
  if (l.cargoPalets !== undefined && l.cargoPalets !== null) {
    if (typeof l.cargoPalets !== 'boolean') throw badRequest(`Línea ${n}: indica si la línea es el cargo de palets (sí o no).`, { campo: `lineas.${i}.cargoPalets` });
    if (l.cargoPalets) out.cargoPalets = true;
  }
  return out;
}

/** 400 PLANTILLA_SIN_CERAMICA: la plantilla de la serie no lleva datos de ceramica. */
export function errorSinCeramica(campo: string, n?: number) {
  return badRequest(
    `${n ? `Línea ${n}: ` : ''}la plantilla de esta serie no lleva palets, cajas, m², piezas, formato, calidad, peso, obra, peso neto ni cargo de palets. Quita esos datos o elige una serie con la plantilla B (cerámica).`,
    { codigo: 'PLANTILLA_SIN_CERAMICA', campo },
  );
}

/** El primer campo de ceramica que trae una linea (para el error). */
function primerCampo(l: DatosCeramicaLinea): string {
  for (const k of [...CAMPOS_MEDIDA, 'formato', 'calidad', 'unidadPrecio'] as const) if (l[k] !== undefined && l[k] !== null && l[k] !== '') return k;
  return 'cargoPalets';
}

/** Quita los datos de ceramica de una linea. */
function sinCeramica(l: LineaEntrada): LineaEntrada {
  const { palets: _p, cajas: _c, metros2: _m, piezas: _pz, formato: _f, calidad: _cal, pesoKg: _k, unidadPrecio: _u, cargoPalets: _cp, ...resto } = l;
  return resto;
}

/** Opciones de aplicarCeramica. */
export interface OpcionesCeramica {
  plantilla: PlantillaVentaId;
  /** Cuenta del cargo de palets (Configuracion > Facturacion) para las lineas del cargo sin cuenta; null = la de ventas. */
  cuentaPalets: string | null;
}

/**
 * Datos de ceramica de las lineas segun la plantilla (puro):
 *  - sin ceramica (estandar, A, C): ninguna linea puede llevarlos (400
 *    PLANTILLA_SIN_CERAMICA con el campo);
 *  - con ceramica (B): sin descuento (400 DESCUENTO_NO_ADMITIDO); las medidas
 *    con el signo de la cantidad (400 SIGNO_MEDIDAS); la unidad del precio
 *    (UNIDAD si no llega) y su dato igual a la cantidad (si no llega, se toma
 *    de ella; distinto, 400 CANTIDAD_NO_CUADRA); con PIEZA, piezas enteras (400
 *    PIEZAS_ENTERAS). El cargo de palets va por unidad, sin medidas, formato
 *    ni calidad (400 CARGO_PALETS_CON_MEDIDAS) y, sin cuenta, con la de los ajustes.
 */
export function aplicarCeramica(lineas: LineaEntrada[], o: OpcionesCeramica): LineaEntrada[] {
  if (!admiteCeramica(o.plantilla)) {
    lineas.forEach((l, i) => {
      if (lineaConCeramica(l)) throw errorSinCeramica(`lineas.${i}.${primerCampo(l)}`, i + 1);
    });
    return lineas.map(sinCeramica);
  }
  return lineas.map((l, i) => {
    const n = i + 1;
    if (Number(l.descuentoPorcentaje ?? 0) !== 0) {
      throw badRequest(`Línea ${n}: la plantilla B no lleva descuento por línea. Pon el precio ya rebajado.`, {
        codigo: 'DESCUENTO_NO_ADMITIDO',
        campo: `lineas.${i}.descuentoPorcentaje`,
      });
    }
    if (l.cargoPalets) {
      const conMedida = [...CAMPOS_MEDIDA, 'formato', 'calidad'].find((k) => {
        const v = l[k as keyof DatosCeramicaLinea];
        return v !== undefined && v !== null && v !== '';
      });
      if (conMedida || (l.unidadPrecio && l.unidadPrecio !== 'UNIDAD')) {
        throw badRequest(`Línea ${n}: el cargo de palets solo lleva la cantidad de palets, el precio de cada uno y su IVA (sin m², cajas, piezas, formato, calidad ni peso).`, {
          codigo: 'CARGO_PALETS_CON_MEDIDAS',
          campo: `lineas.${i}.${conMedida ?? 'unidadPrecio'}`,
        });
      }
      return {
        ...sinCeramica(l),
        unidadPrecio: 'UNIDAD',
        cargoPalets: true,
        ...(l.cuentaContable ? {} : o.cuentaPalets ? { cuentaContable: o.cuentaPalets } : {}),
      };
    }
    const unidad: UnidadPrecio = l.unidadPrecio ?? 'UNIDAD';
    const signo = Math.sign(l.cantidad);
    for (const k of CAMPOS_MEDIDA) {
      const v = Number(l[k] ?? 0);
      if (v !== 0 && Math.sign(v) !== signo) {
        throw badRequest(`Línea ${n}: ${NOMBRE_CAMPO[k]} van con el mismo signo que la cantidad (en negativo solo si la cantidad lo está).`, {
          codigo: 'SIGNO_MEDIDAS',
          campo: `lineas.${i}.${k}`,
        });
      }
    }
    const campoUnidad = unidad === 'M2' ? 'metros2' : 'piezas';
    const dato = l[campoUnidad];
    if (dato !== undefined && dato !== null && milesimas(dato) !== milesimas(l.cantidad)) {
      throw badRequest(
        `Línea ${n}: el precio va por ${NOMBRE_UNIDAD_PRECIO[unidad]}, así que la cantidad que se cobra tiene que ser ${unidad === 'M2' ? 'los m²' : 'las piezas'} de la línea.`,
        { codigo: 'CANTIDAD_NO_CUADRA', campo: `lineas.${i}.${campoUnidad}` },
      );
    }
    const valor = redondear3(l.cantidad);
    if (unidad === 'PIEZA' && !Number.isInteger(valor)) {
      throw badRequest(`Línea ${n}: las piezas son un número entero (si vendes por fracciones, pon el precio por unidad).`, {
        codigo: 'PIEZAS_ENTERAS',
        campo: `lineas.${i}.piezas`,
      });
    }
    const { cargoPalets: _cp, ...resto } = l;
    return { ...resto, unidadPrecio: unidad, [campoUnidad]: valor };
  });
}

/** Lo que lleva la factura de la plantilla B: obra y peso neto (undefined = no llega; null = vacio). */
export interface CabeceraCeramica {
  obra: string | null | undefined;
  pesoNetoKg: number | null | undefined;
}

/** Obra y peso neto del cuerpo, con el formato comprobado (400 con su campo). */
export function leerCabeceraCeramica(dto: { obra?: unknown; pesoNetoKg?: unknown }): CabeceraCeramica {
  let obra: string | null | undefined;
  if (dto.obra === undefined) obra = undefined;
  else if (dto.obra === null || dto.obra === '') obra = null;
  else {
    if (typeof dto.obra !== 'string') throw badRequest('La obra es un texto.', { campo: 'obra' });
    const t = dto.obra.replace(/\s+/g, ' ').trim();
    if (t.length > OBRA_MAX) throw badRequest(`La obra admite ${OBRA_MAX} caracteres como mucho.`, { campo: 'obra' });
    obra = t || null;
  }
  let pesoNetoKg: number | null | undefined;
  if (dto.pesoNetoKg === undefined) pesoNetoKg = undefined;
  else if (dto.pesoNetoKg === null || dto.pesoNetoKg === '') pesoNetoKg = null;
  else {
    const v = numero(dto.pesoNetoKg);
    if (v === null || v < 0 || v > MEDIDA_MAX || Math.abs(Math.round(v * 1000) - v * 1000) > 1e-6) {
      throw badRequest('El peso neto son los kg de la mercancía: un número desde 0 y con 3 decimales como mucho.', { campo: 'pesoNetoKg' });
    }
    pesoNetoKg = v;
  }
  return { obra, pesoNetoKg };
}

/** Con una plantilla sin ceramica, la obra y el peso neto no valen (400 PLANTILLA_SIN_CERAMICA). */
export function exigirCabeceraCeramica(c: CabeceraCeramica, plantilla: PlantillaVentaId): void {
  if (admiteCeramica(plantilla)) return;
  if (c.obra) throw errorSinCeramica('obra');
  if (c.pesoNetoKg !== undefined && c.pesoNetoKg !== null) throw errorSinCeramica('pesoNetoKg');
}
