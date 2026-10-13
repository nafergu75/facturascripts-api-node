/**
 * Validaciones automaticas de una lectura (V01-V22 de la especificacion).
 *
 * Cada una da 'ok', 'revisar' o 'error' con un texto en castellano para la
 * persona. Funciones puras: lo que necesita la BD (NIF de la empresa,
 * duplicados, periodos) llega ya cargado en el contexto, para poder probarlas
 * sin BD. Los importes se comparan siempre en centimos.
 *
 * El estado de cada campo es el peor entre el de su confianza y el de las
 * validaciones que lo tocan, salvo si el QR VERI*FACTU lo confirma.
 */
import { motivoNifIvaNoValido } from '../../aeat/common/normalizacion';
import { MONEDAS_FACTURA_ACTIVAS } from '../../domain/divisas';
import { TIPOS_IVA_GASTO } from '../../domain/factura-gasto.model';
import { limpiarNif, normalizarPais, PREFIJOS_NIF_UE, prefijoNifIvaUe, validarFormatoNifIvaUe } from '../../domain/tipo-operacion.model';
import { nombrePaisEs, pareceNifEspanol, tieneFormaNifIvaUe } from '../../domain/numero-fiscal';
import { esFechaReal } from '../../schemas/factura-gasto.schemas';
import { aCentimos } from '../../utils/money';
import { normalizarNif, validarNifEspanol } from '../../utils/nif';
import { AVISO_NO_FACTURA } from '../gastos-extractor.service';
import {
  UMBRAL_BAJO,
  UMBRAL_OK,
  type Campo,
  type CampoId,
  type EstadoCampo,
  type Lector,
  type LecturaNormalizada,
  type NivelValidacion,
  type ResultadoValidacion,
} from './tipos';
import {
  contradiccionOrigen,
  datosTerceroDeLectura,
  detectarOrigenTercero,
  nifIvaConPrefijo,
  numeroFiscalDe,
  numeroFiscalEnFraseDe,
  tipoTercero,
  type Contradiccion,
  type EleccionOrigenTercero,
  type OrigenDetectado,
  type TipoTercero,
} from './origen-tercero';

export interface ContextoValidacion {
  lector: Lector;
  /** NIF de la empresa (LegalConfig.nif), o null si no lo tiene. */
  nifEmpresa: string | null;
  /**
   * Nombres de la empresa (denominacion de LegalConfig y nombre de Company).
   * Solo se usan si no tiene NIF, para saber de que lado de la factura esta.
   */
  nombresEmpresa?: Array<string | null>;
  empresaEspanola: boolean;
  monedaCuenta: string;
  /** AAAA-MM-DD, hora de Madrid. */
  hoy: string;
  periodoAbierto: (fecha: string) => Promise<boolean>;
  duplicado: { factura: { numeroCompleto: string } | null; archivo: { fecha: string } | null };
  /**
   * De donde ha dicho la persona que es el tercero (el cliente en ventas, el
   * proveedor en gastos) antes de subir la factura. Manda sobre lo que se
   * deduce (origen-tercero.ts). null o sin poner: se deduce.
   */
  origenTercero?: EleccionOrigenTercero | null;
  /** Pais de la ficha del tercero ya dado de alta con el NIF leido (null si no lo hay). */
  paisTerceroFicha?: string | null;
}

/** Error de la lectura de ventas sin NIF de un cliente espanol (tambien lo usa ingresos-extractor). */
export const MENSAJE_FALTA_NIF_CLIENTE = 'Falta el NIF del cliente: es obligatorio en una factura de ingreso.';

export interface ResultadoValidacionLectura {
  campos: Partial<Record<CampoId, EstadoCampo>>;
  /** Solo las que no estan en 'ok'. */
  validaciones: ResultadoValidacion[];
  estado: NivelValidacion;
}

export const TIPOS_RETENCION_VALIDOS = [1, 2, 7, 15, 19];
/** Recargo que corresponde a cada IVA. El del 5 % (0,62) solo se aplico en periodos concretos. */
const RECARGO_DE_IVA: Record<number, number> = { 21: 5.2, 10: 1.4, 4: 0.5, 5: 0.62 };

export const MENSAJE_MONEDA_GASTO = (m: string) =>
  `La factura está en ${m}: las facturas de gasto en otra moneda aún no se pueden registrar. Pasa los importes a euros antes de confirmar.`;

const ORDEN: Record<NivelValidacion, number> = { ok: 0, revisar: 1, error: 2 };
export const peor = (a: NivelValidacion, b: NivelValidacion): NivelValidacion => (ORDEN[b] > ORDEN[a] ? b : a);

const eur = (n: number) => `${n.toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
const pct = (n: number) => `${n.toLocaleString('es-ES', { maximumFractionDigits: 2 })} %`;
const ddmmaaaa = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const v = (codigo: string, nivel: NivelValidacion, campos: CampoId[], mensaje: string): ResultadoValidacion => ({ codigo, nivel, campos, mensaje });
const suma = (xs: Array<number | null | undefined>) => xs.reduce<number>((s, x) => s + (x ?? 0), 0);

// ---------------------------------------------------------------------------
// Importes
// ---------------------------------------------------------------------------

export interface Cuadre {
  bases: number;
  iva: number;
  recargo: number;
  retencion: number;
  calculadoAPagar: number;
  calculadoBruto: number;
  /** Diferencia mayor, en centimos. */
  diferencia: number;
}

/** Cuentas de V01. null si no hay con que cuadrar (sin desglose o sin total). */
export function calcularCuadre(l: LecturaNormalizada): Cuadre | null {
  if (!l.desglose.length || l.desglose.some((t) => t.base.valor === null) || l.totales.totalAPagar.valor === null) return null;
  const bases = suma(l.desglose.map((t) => t.base.valor));
  const iva = suma(l.desglose.map((t) => t.cuota.valor));
  const recargo = suma(l.desglose.map((t) => t.cuotaRecargo?.valor));
  const retencion = l.retencion?.importe.valor ?? l.totales.retencion.valor ?? 0;
  const calculadoBruto = bases + iva + recargo;
  const calculadoAPagar = calculadoBruto - retencion;
  const dPagar = Math.abs(aCentimos(calculadoAPagar) - aCentimos(l.totales.totalAPagar.valor));
  const dBruto = l.totales.totalFactura.valor === null ? 0 : Math.abs(aCentimos(calculadoBruto) - aCentimos(l.totales.totalFactura.valor));
  return { bases, iva, recargo, retencion, calculadoAPagar, calculadoBruto, diferencia: Math.max(dPagar, dBruto) };
}

function v01Cuadre(l: LecturaNormalizada): ResultadoValidacion[] {
  const c = calcularCuadre(l);
  if (!c || c.diferencia === 0) return [];
  const nivel: NivelValidacion = c.diferencia <= 2 ? 'revisar' : 'error';
  const aPagar = l.totales.totalAPagar.valor as number;
  if (aCentimos(c.calculadoAPagar) !== aCentimos(aPagar)) {
    return [
      v('CUADRE', nivel, ['totales.totalAPagar'], `Los importes no cuadran: base ${eur(c.bases)} + IVA ${eur(c.iva)} + recargo ${eur(c.recargo)} − retención ${eur(c.retencion)} = ${eur(c.calculadoAPagar)}, y la factura dice ${eur(aPagar)}.`),
    ];
  }
  const bruto = l.totales.totalFactura.valor as number;
  return [v('CUADRE', nivel, ['totales.totalFactura'], `Los importes no cuadran: base ${eur(c.bases)} + IVA ${eur(c.iva)} + recargo ${eur(c.recargo)} = ${eur(c.calculadoBruto)}, y el total de la factura es ${eur(bruto)}.`)];
}

function v02CuotaTipo(l: LecturaNormalizada): ResultadoValidacion[] {
  return l.desglose.flatMap((t, i) => {
    if (t.base.valor === null || t.cuota.valor === null) return [];
    const lineas = Math.max(l.lineas.filter((x) => x.tipoIva === t.tipoIva).length, 1);
    const sale = (t.base.valor * t.tipoIva) / 100;
    if (Math.abs(aCentimos(sale) - aCentimos(t.cuota.valor)) <= lineas) return [];
    if (t.tipoIva === 0) return [v('CUOTA_TIPO', 'revisar', [`desglose.${i}.cuota`], `La base exenta no lleva IVA y pone ${eur(t.cuota.valor)}.`)];
    return [v('CUOTA_TIPO', 'revisar', [`desglose.${i}.cuota`], `El IVA del ${pct(t.tipoIva)} no corresponde a su base (sale ${eur(sale)} y pone ${eur(t.cuota.valor)}).`)];
  });
}

function v03TipoIva(l: LecturaNormalizada, ctx: ContextoValidacion): ResultadoValidacion[] {
  if (!ctx.empresaEspanola) return [];
  return l.desglose.flatMap((t, i) => {
    if (t.tipoIva === 5) return [v('TIPO_IVA', 'revisar', [`desglose.${i}.base`], 'El IVA del 5 % solo se aplicó en periodos concretos: compruébalo.')];
    if ((TIPOS_IVA_GASTO as readonly number[]).includes(t.tipoIva)) return [];
    return [v('TIPO_IVA', 'error', [`desglose.${i}.base`], `El tipo de IVA ${pct(t.tipoIva)} no existe en España.`)];
  });
}

function v04Recargo(l: LecturaNormalizada): ResultadoValidacion[] {
  return l.desglose.flatMap((t, i) => {
    if (t.tipoRecargo === null) return [];
    const campo: CampoId = `desglose.${i}.recargo`;
    const esperado = RECARGO_DE_IVA[t.tipoIva];
    if (esperado !== t.tipoRecargo) return [v('RECARGO', 'error', [campo], `El recargo del ${pct(t.tipoRecargo)} no corresponde al IVA del ${pct(t.tipoIva)}.`)];
    const r: ResultadoValidacion[] = [];
    if (t.tipoIva === 5) r.push(v('RECARGO', 'revisar', [campo], 'El recargo del 0,62 % (con el IVA del 5 %) solo se aplicó en periodos concretos: compruébalo.'));
    const cuota = t.cuotaRecargo?.valor;
    if (t.base.valor !== null && cuota !== null && cuota !== undefined) {
      const sale = (t.base.valor * t.tipoRecargo) / 100;
      if (Math.abs(aCentimos(sale) - aCentimos(cuota)) > 1) r.push(v('RECARGO', 'error', [campo], `El recargo del ${pct(t.tipoRecargo)} no corresponde a su base (sale ${eur(sale)} y pone ${eur(cuota)}).`));
    }
    return r;
  });
}

/** Gastos con varios tipos de IVA: el formulario los junta en una linea si no se separan a mano. */
function v23VariosTipos(l: LecturaNormalizada, ctx: ContextoValidacion): ResultadoValidacion[] {
  const tipos = [...new Set(l.desglose.map((t) => t.tipoIva))];
  if (ctx.lector !== 'GASTO' || tipos.length < 2) return [];
  // La parte exenta, al final y sin "del 0 %": "IVA del 21 % y una parte exenta".
  const lista = [...tipos.filter((t) => t !== 0).map((t) => `del ${pct(t)}`), ...(tipos.includes(0) ? ['una parte exenta'] : [])];
  const texto = `${lista.slice(0, -1).join(', ')} y ${lista[lista.length - 1]}`;
  return [v('VARIOS_TIPOS_IVA', 'revisar', l.desglose.map((_, i): CampoId => `desglose.${i}.base`), `La factura lleva IVA ${texto}: comprueba que hay una línea por cada tipo, con su base.`)];
}

function v05RecargoNoSoportado(l: LecturaNormalizada, ctx: ContextoValidacion): ResultadoValidacion[] {
  if (!l.desglose.some((t) => t.tipoRecargo !== null)) return [];
  return ctx.lector === 'GASTO'
    ? [v('RECARGO_NO_SOPORTADO', 'revisar', ['totales.totalFactura'], 'La factura lleva recargo de equivalencia y la app aún no lo registra aparte. Revisa cómo apuntarlo.')]
    : [v('RECARGO_NO_SOPORTADO', 'error', ['totales.totalFactura'], 'Las facturas con recargo de equivalencia aún no se pueden registrar con el lector.')];
}

function v06Irpf(l: LecturaNormalizada): ResultadoValidacion[] {
  const r = l.retencion;
  if (!r || !r.importe.valor) return [];
  const tipo = r.tipo.valor;
  const base = suma(l.desglose.map((t) => t.base.valor));
  if (tipo !== null && TIPOS_RETENCION_VALIDOS.includes(tipo) && Math.abs(aCentimos((base * tipo) / 100) - aCentimos(r.importe.valor)) <= 1) return [];
  return [v('IRPF', 'revisar', ['retencion.tipo', 'retencion.importe'], tipo !== null ? `La retención del ${pct(tipo)} no corresponde a la base.` : 'No se ve el porcentaje de la retención: compruébalo.')];
}

// ---------------------------------------------------------------------------
// NIF y empresa
// ---------------------------------------------------------------------------

/** DNI (8 cifras y letra), NIE o NIF especial (X, Y, Z, K, L, M) y CIF (letra, 7 cifras y control). */
const FORMA_NIF_ESPANOL = /^(ES)?(\d{8}[A-Z]|[XYZKLM]\d{7}[A-Z]|[ABCDEFGHJNPQRSUVW]\d{7}[0-9A-J])$/i;

/**
 * Motivo por el que el NIF no vale, o null. Un NIF-IVA de otro pais de la UE
 * solo se mira el formato. Es la regla de la propia empresa (el emisor en
 * ventas, el cliente en gastos) y la de los terceros de una empresa de fuera
 * de Espana cuando no se ha dicho de donde son.
 */
export function motivoNifNoValido(nif: string, empresaEspanola: boolean): string | null {
  const ue = prefijoNifIvaUe(nif);
  if (ue && ue.pais !== 'ES') return validarFormatoNifIvaUe(nif) ? null : `El NIF-IVA ${nif} no tiene un formato válido.`;
  // Empresa de fuera: solo se valida lo que tiene forma de NIF espanol (DNI, NIE o CIF). Nueve cifras son un EIN.
  if (!empresaEspanola && !FORMA_NIF_ESPANOL.test(nif)) return null;
  const r = validarNifEspanol(nif);
  return r.valido ? null : (r.motivo ?? 'El NIF no es válido.');
}

/** Lo que la validacion del NIF del tercero necesita saber de el y de la factura. */
interface TerceroValidado {
  lector: Lector;
  /** «cliente» o «proveedor». */
  tipo: TipoTercero;
  campo: CampoId;
  codigo: 'NIF_EMISOR' | 'NIF_RECEPTOR';
  nif: string | null;
  origen: OrigenDetectado;
  /** Lo leido contradice lo que dijo la persona (ese aviso ya pide cambiarlo). */
  contradiccion: Contradiccion | null;
  /** Factura simplificada (o ticket): no tiene por que llevar el NIF del cliente (art. 7 del RD 1619/2012). */
  simplificada: boolean;
}

/** «Si el cliente es de otro país, cámbialo en «¿De dónde es el cliente?».» */
const siEsDeOtroPais = (tipo: TipoTercero) => `Si el ${tipo} es de otro país, cámbialo en «¿De dónde es el ${tipo}?».`;

/**
 * Sin NIF del tercero (el cliente en ventas, el proveedor en gastos). El
 * numero del destinatario es obligatorio en la factura completa (art. 6.1.d
 * del RD 1619/2012) en la entrega intracomunitaria exenta, cuando el cliente
 * es el sujeto pasivo (inversion) y en toda operacion que se entienda hecha en
 * Espana, tambien la exportacion al 0 % (art. 68.Dos LIVA). No lo es en un
 * servicio que no se localiza en Espana (arts. 69 y 70 LIVA) ni en la factura
 * simplificada (art. 7).
 * - De Espana (o sin saber de donde es): como siempre. En ventas es error (en
 *   la simplificada, «revisar»: hace falta elegir el cliente, pero la ley no lo
 *   pide); en gastos, error si la empresa es espanola.
 * - Dicho de otro pais, pero su direccion esta en Espana: un tercero espanol
 *   sin NIF sigue siendo error (la contradiccion propone cambiarlo).
 * - De otro pais de la UE: «revisar». En ventas, sin su NIF-IVA no puede ir
 *   como entrega intracomunitaria exenta (art. 25 LIVA) ni como servicio con
 *   inversion del sujeto pasivo en destino (art. 69.Uno.1.º LIVA); el tipo de
 *   operacion lo decide despues la fiscalidad de la venta (inferirTipoOperacion).
 * - De fuera de la UE: «revisar», diciendo cuando es obligatorio.
 */
function faltaNifTercero(t: TerceroValidado, ctx: ContextoValidacion): ResultadoValidacion[] {
  const venta = t.lector === 'VENTA';
  const elegido = t.origen.por === 'eleccion';
  const espanolPorDireccion = t.contradiccion?.origen === 'ES';
  if (t.origen.origen === 'UE' && !espanolPorDireccion) {
    const n = numeroFiscalDe(t.origen);
    const mensaje = venta
      ? `Falta el ${n} del cliente. Sin él, la venta no puede ir como entrega intracomunitaria exenta (art. 25 de la Ley del IVA) y, si es un servicio a una empresa, tampoco sin IVA español (art. 69 de la Ley del IVA): compruébalo.`
      : `No se ha podido leer el ${n} del proveedor: compruébalo con la factura.`;
    return [v(t.codigo, 'revisar', [t.campo], mensaje)];
  }
  if (t.origen.origen === 'FUERA' && !espanolPorDireccion) {
    const n = numeroFiscalEnFraseDe(t.origen);
    const mensaje = venta
      ? `La factura no lleva el ${n} del cliente. Es obligatorio si la venta se entiende hecha en España, también en una exportación de bienes al 0 % (art. 6.1.d del Reglamento de facturación); no lo es en un servicio que no se presta en España (arts. 69 y 70 de la Ley del IVA): compruébalo.`
      : `No se ha podido leer el ${n} del proveedor. Un proveedor de fuera de la UE puede no tenerlo en la factura: compruébalo.`;
    return [v(t.codigo, 'revisar', [t.campo], mensaje)];
  }
  // De Espana o sin saber de donde es: como siempre. Si lo dijo la persona, como salir de ahi.
  const otroPais = elegido && !t.contradiccion ? ` ${siEsDeOtroPais(t.tipo)}` : '';
  if (venta && t.simplificada) return [v(t.codigo, 'revisar', [t.campo], MENSAJE_SIMPLIFICADA_SIN_NIF)];
  if (venta) return [v(t.codigo, 'error', [t.campo], `${MENSAJE_FALTA_NIF_CLIENTE}${otroPais}`)];
  return [v(t.codigo, ctx.empresaEspanola ? 'error' : 'revisar', [t.campo], `No se ha podido leer el NIF del proveedor.${otroPais}`)];
}

/** Factura simplificada de venta sin NIF del cliente: la ley no lo pide (art. 7), pero sin cliente no se registra. */
export const MENSAJE_SIMPLIFICADA_SIN_NIF =
  'La factura simplificada no lleva el NIF del cliente: no es obligatorio en ella (art. 7 del Reglamento de facturación), pero para registrarla elige el cliente o dalo de alta.';

/**
 * NIF-IVA de un tercero de otro pais de la UE: con o sin prefijo, quitando
 * espacios y puntos. Con prefijo, el numero tiene que tener la composicion de
 * su Estado que pide el modelo 349 (motivoNifIvaNoValido, la tabla del diseno
 * de registro de la AEAT): sin ella no da la exencion del art. 25 LIVA ni
 * entra en el 349, y es error. Si viene de la ficha de un tercero ya dado de
 * alta, se avisa para que se corrija alli. La forma de cada Estado de
 * domain/numero-fiscal.ts (la de VIES) solo sirve para reconocer un numero
 * leido sin prefijo y para un aviso mas fino.
 */
function nifIvaUeNoValido(t: TerceroValidado): ResultadoValidacion[] {
  const nif = limpiarNif(t.nif);
  const pais = t.origen.pais;
  const nombre = pais ? nombrePaisEs(pais) : null;
  const pref = prefijoNifIvaUe(nif);
  const letras = nif.slice(0, 2);
  // Empieza por el prefijo de un Estado (FR, DE...) pero no tiene el largo de un NIF-IVA.
  if (!pref && /^[A-Z]{2}/.test(nif) && letras !== 'ES' && PREFIJOS_NIF_UE[letras]) return [v(t.codigo, 'error', [t.campo], `El NIF-IVA ${nif} no tiene un formato válido.`)];
  // XI: Irlanda del Norte (solo en las entregas de bienes); la fiscalidad de la venta lo trata aparte.
  if (pref?.prefijo === 'XI') return [];
  if (pref && pref.prefijo !== 'ES') {
    if (!validarFormatoNifIvaUe(nif)) return [v(t.codigo, 'error', [t.campo], `El NIF-IVA ${nif} no tiene un formato válido.`)];
    // Otro pais que el dicho: lo explica el aviso de la contradiccion.
    if (pais && normalizarPais(pref.pais) !== normalizarPais(pais)) {
      return t.contradiccion ? [] : [v(t.codigo, 'revisar', [t.campo], `El NIF-IVA ${nif} es de ${nombrePaisEs(pref.pais)} y el ${t.tipo} es de ${nombre}: compruébalo.`)];
    }
    const motivo = motivoNifIvaNoValido(pref.prefijo, nif.slice(2));
    if (motivo) {
      const deFicha = t.origen.por === 'ficha';
      const mensaje = deFicha
        ? `El NIF-IVA de la ficha del ${t.tipo} no es válido: ${motivo}. Corrígelo en su ficha: así no entra en el modelo 349.`
        : `El NIF-IVA ${nif} no es válido: ${motivo}. Corrígelo con la factura: sin un NIF-IVA válido no entra en el modelo 349 ni da la exención intracomunitaria.`;
      return [v(t.codigo, deFicha ? 'revisar' : 'error', [t.campo], mensaje)];
    }
    if (!tieneFormaNifIvaUe(pref.prefijo, nif.slice(2))) {
      return [v(t.codigo, 'revisar', [t.campo], `El NIF-IVA ${nif} no tiene la forma de los de ${nombrePaisEs(pref.pais)}: compruébalo con la factura.`)];
    }
    return [];
  }
  // Sin prefijo y con la forma de los de su pais: se propone con el prefijo. Antes que mirar si
  // parece un NIF espanol: uno de Irlanda o de Chipre sin prefijo tiene la forma de un DNI.
  const conPrefijo = nifIvaConPrefijo(nif, pais);
  if (conPrefijo) {
    return [
      {
        ...v(t.codigo, 'revisar', [t.campo], `El NIF-IVA se ha leído sin el prefijo del país: es ${conPrefijo}. Compruébalo y escríbelo así en la ficha del ${t.tipo}.`),
        sugerencia: conPrefijo,
      },
    ];
  }
  // Un NIF espanol (con o sin ES, con su control) en un tercero que se ha dicho de otro pais de la UE.
  if ((pref?.prefijo === 'ES' || pareceNifEspanol(nif)) && validarNifEspanol(nif).valido) {
    return t.contradiccion ? [] : [v(t.codigo, 'revisar', [t.campo], `${nif} es un NIF español, no un NIF-IVA de otro país de la UE: compruébalo.`)];
  }
  if (nombre) return [v(t.codigo, 'revisar', [t.campo], `${nif} no tiene la forma de un NIF-IVA de ${nombre}: compruébalo con la factura.`)];
  return [v(t.codigo, 'revisar', [t.campo], `El NIF-IVA ${nif} se ha leído sin el prefijo del país (FR, DE, IT...): compruébalo e indica de qué país es el ${t.tipo}.`)];
}

/** «Si el cliente es de España, cámbialo en «¿De dónde es el cliente?».» */
const siEsDeEspana = (tipo: TipoTercero) => `Si el ${tipo} es de España, cámbialo en «¿De dónde es el ${tipo}?».`;

/**
 * De fuera de la UE: su identificacion se acepta tal cual. Si no se sabe de
 * que pais es y el numero tiene la forma de un NIF espanol, puede ser uno mal
 * leido (o un tercero de España marcado como de fuera): «revisar».
 */
function nifFueraNoValido(t: TerceroValidado): ResultadoValidacion[] {
  const nif = limpiarNif(t.nif);
  if (t.contradiccion || t.origen.pais || !pareceNifEspanol(nif)) return [];
  const mensaje = validarNifEspanol(nif).valido
    ? `${nif} es un NIF español. ${siEsDeEspana(t.tipo)}`
    : `${nif} parece un NIF español, pero su letra o cifra de control no cuadra: compruébalo con la factura. ${siEsDeEspana(t.tipo)}`;
  return [v(t.codigo, 'revisar', [t.campo], mensaje)];
}

/**
 * El NIF del tercero, segun de donde sea:
 * - de Espana: NIF espanol valido (con su control), como siempre;
 * - de otro pais de la UE: NIF-IVA por su formato (nifIvaUeNoValido);
 * - de fuera de la UE: su identificacion se acepta tal cual (nifFueraNoValido);
 * - sin saber de donde es y sin forma de NIF espanol: «revisar», pidiendo el pais.
 * En una empresa de fuera de Espana, si no se ha dicho de donde es el tercero,
 * la regla de siempre (motivoNifNoValido).
 */
function nifTerceroNoValido(t: TerceroValidado, ctx: ContextoValidacion): ResultadoValidacion[] {
  const nif = t.nif as string;
  if (!ctx.empresaEspanola && t.origen.por !== 'eleccion') {
    const motivo = motivoNifNoValido(nif, false);
    return motivo ? [v(t.codigo, 'error', [t.campo], motivo)] : [];
  }
  switch (t.origen.origen) {
    case 'ES': {
      const r = validarNifEspanol(nif);
      if (r.valido) return [];
      const otroPais = t.origen.por === 'eleccion' && !t.contradiccion && !pareceNifEspanol(nif) ? ` ${siEsDeOtroPais(t.tipo)}` : '';
      return [v(t.codigo, 'error', [t.campo], `${r.motivo ?? 'El NIF no es válido.'}${otroPais}`)];
    }
    case 'UE':
      return nifIvaUeNoValido(t);
    case 'FUERA':
      return nifFueraNoValido(t);
    default:
      return [v(t.codigo, 'revisar', [t.campo], `${limpiarNif(nif)} no parece un NIF español. Si el ${t.tipo} es de otro país, indícalo en «¿De dónde es el ${t.tipo}?».`)];
  }
}

/** El tercero de la factura: el proveedor (emisor) en gastos y el cliente (receptor) en ventas. */
function terceroDe(l: LecturaNormalizada, ctx: ContextoValidacion): TerceroValidado {
  const venta = ctx.lector === 'VENTA';
  const d = datosTerceroDeLectura(ctx.lector, l, { eleccion: ctx.origenTercero ?? null, paisFicha: ctx.paisTerceroFicha ?? null });
  return {
    lector: ctx.lector,
    tipo: tipoTercero(ctx.lector),
    campo: venta ? 'receptor.nif' : 'emisor.nif',
    codigo: venta ? 'NIF_RECEPTOR' : 'NIF_EMISOR',
    nif: (venta ? l.receptor : l.emisor).nif.valor,
    origen: detectarOrigenTercero(d),
    contradiccion: contradiccionOrigen(d, tipoTercero(ctx.lector)),
    simplificada: ['simplificada', 'ticket'].includes(l.tipoDocumento.valor ?? ''),
  };
}

/** V07, V08 y la contradiccion con lo que se dijo: el NIF del tercero. */
function nifDelTercero(l: LecturaNormalizada, ctx: ContextoValidacion): ResultadoValidacion[] {
  const t = terceroDe(l, ctx);
  const r = t.nif ? nifTerceroNoValido(t, ctx) : faltaNifTercero(t, ctx);
  if (t.contradiccion) r.push(v('ORIGEN_TERCERO', 'revisar', [t.campo], t.contradiccion.mensaje));
  return r;
}

/** V07: en gastos, el proveedor (nifDelTercero); en ventas, el emisor es la propia empresa. */
function v07NifEmisor(l: LecturaNormalizada, ctx: ContextoValidacion): ResultadoValidacion[] {
  if (ctx.lector === 'GASTO') return nifDelTercero(l, ctx);
  const nif = l.emisor.nif.valor;
  if (!nif) return [];
  const motivo = motivoNifNoValido(nif, ctx.empresaEspanola);
  return motivo ? [v('NIF_EMISOR', 'error', ['emisor.nif'], motivo)] : [];
}

/** V08: en ventas, el cliente (nifDelTercero); en gastos, el receptor es la propia empresa. */
function v08NifReceptor(l: LecturaNormalizada, ctx: ContextoValidacion): ResultadoValidacion[] {
  if (ctx.lector === 'VENTA') return nifDelTercero(l, ctx);
  const nif = l.receptor.nif.valor;
  if (!nif) {
    // La lectura de gastos con Claude no pregunta por el cliente: que falte no dice nada.
    if (l.receptor.nif.fuente === 'claude') return [];
    if (['simplificada', 'ticket', 'recibo'].includes(l.tipoDocumento.valor ?? '')) return [];
    return [v('NIF_RECEPTOR', 'revisar', ['receptor.nif'], 'La factura no lleva el NIF de la empresa como cliente: compruébalo.')];
  }
  const motivo = motivoNifNoValido(nif, ctx.empresaEspanola);
  return motivo ? [v('NIF_RECEPTOR', 'error', ['receptor.nif'], motivo)] : [];
}

/** Formas societarias que no cuentan al comparar nombres (ya sin puntos ni espacios). */
const FORMAS_SOCIETARIAS = new Set(['SL', 'SA', 'SLU', 'SAU', 'SLL', 'SAL', 'SLP', 'SLNE', 'SC', 'SCP', 'SCOOP', 'SCL', 'CB', 'SRL', 'LTD', 'LIMITED', 'LLC', 'INC', 'CORP', 'GMBH']);

/**
 * Nombre de una sociedad listo para comparar: en mayusculas, sin tildes, sin
 * puntuacion y sin la forma societaria («Cerámicas Núñez, S.L.» -> «CERAMICAS NUNEZ»).
 */
export function normalizarNombreSociedad(nombre: string | null | undefined): string {
  if (!nombre) return '';
  const texto = nombre
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/\bSOCIEDAD\s+(LIMITADA|ANONIMA)(\s+(UNIPERSONAL|LABORAL|PROFESIONAL|NUEVA EMPRESA))?\b/g, ' ')
    .replace(/\./g, '')
    .replace(/[^A-Z0-9]+/g, ' ');
  // Las letras sueltas seguidas van juntas: «S L U» (de «S. L. U.») es «SLU».
  const palabras: string[] = [];
  let letras = '';
  for (const p of texto.split(' ').filter(Boolean)) {
    if (p.length === 1) {
      letras += p;
      continue;
    }
    if (letras) palabras.push(letras);
    letras = '';
    palabras.push(p);
  }
  if (letras) palabras.push(letras);
  return palabras.filter((p) => !FORMAS_SOCIETARIAS.has(p)).join(' ');
}

/**
 * Como se parecen dos nombres de sociedad, una vez normalizados:
 * - 'igual': son el mismo nombre («Ifeval Inversiones, S.L.» e «IFEVAL INVERSIONES SL»);
 * - 'contiene': uno contiene al otro por palabras completas, con al menos dos
 *   palabras o cinco letras («Ifeval» e «IFEVAL SPORT SL»). Puede ser otra
 *   sociedad con un nombre parecido, asi que esto solo no bloquea nada;
 * - null: no se parecen, o falta alguno.
 */
export function compararNombresSociedad(a: string | null | undefined, b: string | null | undefined): 'igual' | 'contiene' | null {
  const x = normalizarNombreSociedad(a);
  const y = normalizarNombreSociedad(b);
  if (!x || !y) return null;
  if (x === y) return 'igual';
  const [corto, largo] = x.length <= y.length ? [x, y] : [y, x];
  if (!corto.includes(' ') && corto.length < 5) return null;
  return ` ${largo} `.includes(` ${corto} `) ? 'contiene' : null;
}

/** Si dos nombres de sociedad se parecen: iguales o uno dentro del otro (ver compararNombresSociedad). */
export function nombresParecidos(a: string | null | undefined, b: string | null | undefined): boolean {
  return compararNombresSociedad(a, b) !== null;
}

const MENSAJE_EMITIDA_POR_EMPRESA = 'Parece una factura emitida por la empresa: léela en el lector de ventas.';
const MENSAJE_RECIBIDA_POR_EMPRESA = 'Parece una factura recibida por la empresa: léela en el lector de gastos.';

/**
 * Textos de V09 cuando la empresa no tiene NIF. En las empresas de fuera de
 * Espana el campo se llama «Identificación fiscal» en Más > Datos de la
 * empresa (legalConfig.service), y asi se le llama aqui.
 */
function textosSinNif(lector: Lector, espanola: boolean): { pideNif: string; deducido: string } {
  const queComprobar = lector === 'VENTA' ? 'la haya emitido ella' : 'vaya a su nombre';
  return espanola
    ? {
        pideNif: `Tu empresa no tiene el NIF en Más > Datos de la empresa: no se puede comprobar que esta factura ${queComprobar}. Ponlo para que el lector lo compruebe.`,
        deducido: 'Lo hemos deducido por el nombre porque tu empresa no tiene el NIF puesto; si no es así, ponlo en Más > Datos de la empresa y vuelve a leerla.',
      }
    : {
        pideNif: `Tu empresa no tiene la identificación fiscal en Más > Datos de la empresa: no se puede comprobar que esta factura ${queComprobar}. Ponla para que el lector la compruebe.`,
        deducido:
          'Lo hemos deducido por el nombre porque tu empresa no tiene la identificación fiscal puesta; si no es así, ponla en Más > Datos de la empresa y vuelve a leerla.',
      };
}

function v09Empresa(l: LecturaNormalizada, ctx: ContextoValidacion): ResultadoValidacion[] {
  if (!ctx.nifEmpresa) return v09EmpresaSinNif(l, ctx);
  const empresa = normalizarNif(ctx.nifEmpresa);
  const emisor = l.emisor.nif.valor ? normalizarNif(l.emisor.nif.valor) : null;
  const receptor = l.receptor.nif.valor ? normalizarNif(l.receptor.nif.valor) : null;
  const r: ResultadoValidacion[] = [];
  if (ctx.lector === 'GASTO') {
    if (emisor === empresa) r.push(v('EMPRESA', 'error', ['emisor.nif'], MENSAJE_EMITIDA_POR_EMPRESA));
    else if (receptor && receptor !== empresa) r.push(v('EMPRESA', 'revisar', ['receptor.nif'], `La factura no va a nombre de la empresa (NIF del cliente: ${receptor}).`));
  } else {
    if (receptor === empresa) r.push(v('EMPRESA', 'error', ['receptor.nif'], MENSAJE_RECIBIDA_POR_EMPRESA));
    else if (emisor && emisor !== empresa) r.push(v('EMPRESA', 'revisar', ['emisor.nif'], `La factura no la ha emitido la empresa (NIF del emisor: ${emisor}).`));
  }
  return r;
}

/** El mayor parecido entre los nombres de la empresa y un nombre leido. */
function parecidoConEmpresa(nombres: string[], leido: string | null): 'igual' | 'contiene' | null {
  const parecidos = nombres.map((n) => compararNombresSociedad(n, leido));
  return parecidos.includes('igual') ? 'igual' : parecidos.includes('contiene') ? 'contiene' : null;
}

/**
 * La empresa no tiene NIF: no se puede comprobar del todo, asi que nunca queda
 * en 'ok'. Se compara su nombre con el del emisor y el del cliente leidos. Su
 * lado es el emisor en ventas y el cliente en gastos; la otra parte, al reves.
 * - error (es una factura del otro lector) solo si su nombre es el MISMO que
 *   el de la otra parte y el de su lado se ha leido y no se parece en nada.
 *   Si no se ha leido el de su lado (gastos leidos con Claude sin el cliente),
 *   no hay con que confirmarlo;
 * - 'revisar' diciendo a que se parece si se parece a la otra parte sin llegar
 *   a eso (uno contiene al otro: «Ifeval» e «IFEVAL SPORT SL»);
 * - si no, 'revisar' pidiendo el NIF y, si el nombre de su lado no se parece,
 *   diciendo que nombre se ha leido.
 */
function v09EmpresaSinNif(l: LecturaNormalizada, ctx: ContextoValidacion): ResultadoValidacion[] {
  const nombres = (ctx.nombresEmpresa ?? []).filter((n): n is string => !!n && !!normalizarNombreSociedad(n));
  const venta = ctx.lector === 'VENTA';
  const propio = venta ? l.emisor : l.receptor;
  const otro = venta ? l.receptor : l.emisor;
  const nifPropio: CampoId = venta ? 'emisor.nif' : 'receptor.nif';
  const nombrePropio: CampoId = venta ? 'emisor.nombre' : 'receptor.nombre';
  const nombreOtro: CampoId = venta ? 'receptor.nombre' : 'emisor.nombre';
  const textos = textosSinNif(ctx.lector, ctx.empresaEspanola);
  const leidoPropio = propio.nombre.valor?.trim() || null;
  const leidoOtro = otro.nombre.valor?.trim() || null;
  const conPropio = parecidoConEmpresa(nombres, leidoPropio);
  const conOtro = parecidoConEmpresa(nombres, leidoOtro);

  if (conOtro === 'igual' && conPropio === null && normalizarNombreSociedad(leidoPropio)) {
    return [v('EMPRESA', 'error', [nombreOtro], `${venta ? MENSAJE_RECIBIDA_POR_EMPRESA : MENSAJE_EMITIDA_POR_EMPRESA} ${textos.deducido}`)];
  }
  if (conOtro && conPropio !== 'igual') {
    const quien = venta ? 'el cliente' : 'el proveedor';
    const lectorBueno = venta ? 'gastos' : 'ventas';
    return [
      v(
        'EMPRESA',
        'revisar',
        [nifPropio, nombreOtro],
        `Puede que sea una factura ${venta ? 'recibida' : 'emitida'} por tu empresa: ${quien} que se ha leído, «${leidoOtro}», se parece al nombre de tu empresa. Si es así, léela en el lector de ${lectorBueno}. ${textos.deducido}`,
      ),
    ];
  }
  if (conPropio || !leidoPropio || !nombres.length) return [v('EMPRESA', 'revisar', [nifPropio], textos.pideNif)];
  const quien = venta ? 'El emisor' : 'El cliente';
  return [v('EMPRESA', 'revisar', [nifPropio, nombrePropio], `${textos.pideNif} ${quien} que se ha leído es «${leidoPropio}», que no se parece al nombre de tu empresa.`)];
}

// ---------------------------------------------------------------------------
// Fechas
// ---------------------------------------------------------------------------

function restarAnios(iso: string, anios: number): string {
  return `${String(Number(iso.slice(0, 4)) - anios).padStart(4, '0')}${iso.slice(4)}`;
}

function v10v11Fecha(l: LecturaNormalizada, ctx: ContextoValidacion): ResultadoValidacion[] {
  const f = l.fechaEmision.valor;
  if (!f) return [];
  if (!esFechaReal(f) || f < '2000-01-01') return [v('FECHA', 'error', ['fechaEmision'], 'La fecha de la factura no existe.')];
  if (f > ctx.hoy) return [v('FECHA', 'error', ['fechaEmision'], 'La fecha de la factura es posterior a hoy.')];
  if (f < restarAnios(ctx.hoy, 4)) return [v('FECHA_ANTIGUA', 'revisar', ['fechaEmision'], 'La factura tiene más de cuatro años: comprueba la fecha.')];
  return [];
}

function v12Vencimiento(l: LecturaNormalizada): ResultadoValidacion[] {
  const e = l.fechaEmision.valor;
  const vto = l.fechaVencimiento.valor;
  if (!e || !vto || vto >= e) return [];
  return [v('VENCIMIENTO', 'revisar', ['fechaVencimiento'], 'El vencimiento es anterior a la fecha de la factura.')];
}

async function v13Periodo(l: LecturaNormalizada, ctx: ContextoValidacion): Promise<ResultadoValidacion[]> {
  const f = l.fechaEmision.valor;
  if (!f || !esFechaReal(f) || f > ctx.hoy) return [];
  if (await ctx.periodoAbierto(f)) return [];
  return [v('PERIODO', 'revisar', ['fechaEmision'], 'El periodo de esa fecha está cerrado o presentado: tendrás que registrarla con otra fecha.')];
}

// ---------------------------------------------------------------------------
// Duplicados, obligatorios y demas
// ---------------------------------------------------------------------------

function v14v15Duplicados(ctx: ContextoValidacion): ResultadoValidacion[] {
  const r: ResultadoValidacion[] = [];
  if (ctx.duplicado.factura) r.push(v('DUPLICADA', 'error', ['numero'], `Ya registraste esta factura (${ctx.duplicado.factura.numeroCompleto}).`));
  if (ctx.duplicado.archivo) r.push(v('ARCHIVO_REPETIDO', 'revisar', [], `Este mismo archivo ya se registró el ${ddmmaaaa(ctx.duplicado.archivo.fecha)}.`));
  return r;
}

function v16Obligatorios(l: LecturaNormalizada): ResultadoValidacion[] {
  const r: ResultadoValidacion[] = [];
  if (!l.numero.valor) r.push(v('OBLIGATORIOS', 'error', ['numero'], 'No se ha podido leer el número de la factura.'));
  if (!l.fechaEmision.valor) r.push(v('OBLIGATORIOS', 'error', ['fechaEmision'], 'No se ha podido leer la fecha de la factura.'));
  if (!l.desglose.length) r.push(v('OBLIGATORIOS', 'error', ['totales.base'], 'No se ha podido leer ninguna base imponible.'));
  l.desglose.forEach((t, i) => {
    if (t.base.valor === null) r.push(v('OBLIGATORIOS', 'error', [`desglose.${i}.base`], `No se ha podido leer la base del ${pct(t.tipoIva)}.`));
  });
  if (l.totales.totalAPagar.valor === null) r.push(v('OBLIGATORIOS', 'error', ['totales.totalAPagar'], 'No se ha podido leer el total de la factura.'));
  return r;
}

function v17Moneda(l: LecturaNormalizada, ctx: ContextoValidacion): ResultadoValidacion[] {
  const m = l.moneda.valor;
  if (!m) return [];
  if (ctx.lector === 'GASTO') return m !== 'EUR' ? [v('MONEDA', 'error', ['moneda'], MENSAJE_MONEDA_GASTO(m))] : [];
  if (!MONEDAS_FACTURA_ACTIVAS.includes(m)) return [v('MONEDA', 'error', ['moneda'], `La factura está en ${m}: solo se pueden registrar facturas en euros o en dólares.`)];
  // El alta desde el lector no guarda la moneda: solo se registra en la de la contabilidad.
  if (m !== ctx.monedaCuenta) {
    return [v('MONEDA', 'error', ['moneda'], `La factura está en ${m} y la empresa lleva sus cuentas en ${ctx.monedaCuenta}: el lector aún no registra ventas en otra moneda.`)];
  }
  return [];
}

const CAMPO_QR: Record<string, CampoId> = { nif: 'emisor.nif', numero: 'numero', fecha: 'fechaEmision', importe: 'totales.totalFactura' };
const NOMBRE_QR: Record<string, string> = { nif: 'el NIF del emisor', numero: 'el número', fecha: 'la fecha', importe: 'el importe' };

function v18Qr(l: LecturaNormalizada): ResultadoValidacion[] {
  const qr = l.qr;
  if (!qr) return [];
  if (qr.estado === 'ILEGIBLE' || (qr.estado === 'NO_COINCIDE' && qr.motivo)) return [v('QR', 'revisar', [], qr.motivo ?? 'El QR VERI*FACTU está mal formado; no se ha podido comprobar.')];
  return qr.diferencias.map((d) => {
    const enQr = d.campo === 'importe' ? eur(Number(d.enQr)) : d.campo === 'fecha' ? ddmmaaaa(d.enQr) : d.enQr;
    const leido = d.leido === null ? '' : d.campo === 'importe' ? eur(Number(d.leido)) : d.campo === 'fecha' ? ddmmaaaa(d.leido) : d.leido;
    let mensaje = `El QR VERI*FACTU no coincide con la factura en ${NOMBRE_QR[d.campo]} (QR ${enQr}; leído ${leido}).`;
    if (d.campo === 'importe' && d.nivel === 'revisar') mensaje = `El importe del QR VERI*FACTU (${enQr}) es el total a pagar, no el total de la factura (${leido}): compruébalo.`;
    if (d.campo === 'numero' && d.nivel === 'revisar') mensaje = `El número leído no lleva la serie que trae el QR VERI*FACTU (QR ${enQr}; leído ${leido}).`;
    return v('QR', d.nivel, [CAMPO_QR[d.campo]], mensaje);
  });
}

export const MENSAJE_IMPORTES_NEGATIVOS = 'Los importes son negativos: parece una rectificativa o un abono y aún no se puede registrar con el lector.';

/** Alguna base o algun total en negativo: un abono, aunque no diga "rectificativa". */
export function importesNegativos(l: LecturaNormalizada): boolean {
  const importes = [...l.desglose.map((t) => t.base.valor), l.totales.totalFactura.valor, l.totales.totalAPagar.valor];
  return importes.some((x) => typeof x === 'number' && aCentimos(x) < 0);
}

/** V19 en el lector de gastos: una rectificativa o un abono se registra como abono (seccion 12 de la especificacion de abonos). */
export const mensajeRectificativaGasto = (n: string | null | undefined) =>
  `Es una rectificativa o un abono${n ? ` (rectifica a la ${n})` : ''}: se registrará como abono. Comprueba la factura que rectifica.`;

/** V19 en el lector de ventas: una rectificativa o un abono se registra como rectificativa, con la factura que rectifica. */
export const mensajeRectificativaVenta = (n: string | null | undefined) =>
  `Es una rectificativa o un abono${n ? ` (rectifica a la ${n})` : ''}: se registrará como rectificativa. Comprueba la factura que rectifica.`;

/**
 * V19 y V20. Una rectificativa o importes en negativo: para revisar en los
 * dos lectores. En gastos el formulario se abre como abono; en ventas, como
 * rectificativa, con la factura que rectifica propuesta por el numero leido.
 */
function v19v20TipoDocumento(l: LecturaNormalizada, ctx: Pick<ContextoValidacion, 'lector'>): ResultadoValidacion[] {
  const tipo = l.tipoDocumento.valor;
  const mensaje = ctx.lector === 'GASTO' ? mensajeRectificativaGasto : mensajeRectificativaVenta;
  if (tipo === 'rectificativa') {
    const n = l.rectificativa?.numeroRectificada.valor;
    return [v('RECTIFICATIVA', 'revisar', ['tipoDocumento'], mensaje(n))];
  }
  if (importesNegativos(l)) return [v('RECTIFICATIVA', 'revisar', ['tipoDocumento', 'totales.totalAPagar'], mensaje(null))];
  if (tipo === 'nomina' || tipo === 'seguros_sociales') return [v('NO_FACTURA', 'revisar', ['tipoDocumento'], AVISO_NO_FACTURA[tipo])];
  return [];
}

function v21v22Totales(l: LecturaNormalizada): ResultadoValidacion[] {
  const r: ResultadoValidacion[] = [];
  const { archivo, leidas } = l.paginas;
  if (archivo !== null && leidas !== null && archivo > leidas) {
    r.push(v('PAGINAS_SIN_LEER', 'revisar', ['totales.totalFactura'], `Solo se han leído las ${leidas} primeras páginas. Comprueba que los totales son los de la factura completa.`));
  }
  if (l.senales?.descuento) r.push(v('DESCUENTO', 'revisar', ['totales.base'], 'La factura lleva un descuento global: comprueba la base.'));
  if (l.senales?.saldoAnterior) r.push(v('SALDO_ANTERIOR', 'revisar', ['totales.totalAPagar'], 'El total a pagar incluye deudas anteriores: comprueba el importe de esta factura.'));
  return r;
}

/** Todas menos la del periodo (V13), que necesita la BD. */
export function validacionesSincronas(l: LecturaNormalizada, ctx: ContextoValidacion): ResultadoValidacion[] {
  return [
    ...v01Cuadre(l),
    ...v02CuotaTipo(l),
    ...v03TipoIva(l, ctx),
    ...v04Recargo(l),
    ...v05RecargoNoSoportado(l, ctx),
    ...v23VariosTipos(l, ctx),
    ...v06Irpf(l),
    ...v07NifEmisor(l, ctx),
    ...v08NifReceptor(l, ctx),
    ...v09Empresa(l, ctx),
    ...v10v11Fecha(l, ctx),
    ...v12Vencimiento(l),
    ...v14v15Duplicados(ctx),
    ...v16Obligatorios(l),
    ...v17Moneda(l, ctx),
    ...v18Qr(l),
    ...v19v20TipoDocumento(l, ctx),
    ...v21v22Totales(l),
  ];
}

// ---------------------------------------------------------------------------
// Estado por campo
// ---------------------------------------------------------------------------

/** Estado de un campo solo por su confianza (seccion 6). */
export function estadoPorConfianza(c: Campo<unknown>): { nivel: NivelValidacion; motivo: string | null } {
  if (c.fuente === 'qr' && c.confianza === 1) return { nivel: 'ok', motivo: null };
  if (c.motivo) return { nivel: 'revisar', motivo: c.motivo };
  if (c.valor === null) return { nivel: 'ok', motivo: null };
  if (c.fuente === 'azure' && c.confianza === null) return { nivel: 'revisar', motivo: 'No se ha podido leer bien.' };
  if (typeof c.confianza === 'number' && (c.fuente === 'azure' || c.fuente === 'calculado')) {
    if (c.confianza < UMBRAL_BAJO) return { nivel: 'revisar', motivo: 'No se ha podido leer bien.' };
    if (c.confianza < UMBRAL_OK) return { nivel: 'revisar', motivo: `Azure lo ha leído con poca seguridad (${Math.round(c.confianza * 100)} %).` };
  }
  return { nivel: 'ok', motivo: null };
}

/** Los campos de la lectura con su identificador. */
export function camposDeLectura(l: LecturaNormalizada): Array<[CampoId, Campo<unknown>]> {
  const lista: Array<[CampoId, Campo<unknown>]> = [
    ['tipoDocumento', l.tipoDocumento],
    ['emisor.nombre', l.emisor.nombre],
    ['emisor.nif', l.emisor.nif],
    ['receptor.nombre', l.receptor.nombre],
    ['receptor.nif', l.receptor.nif],
    ['numero', l.numero],
    ['fechaEmision', l.fechaEmision],
    ['fechaVencimiento', l.fechaVencimiento],
    ['moneda', l.moneda],
  ];
  l.desglose.forEach((t, i) => {
    lista.push([`desglose.${i}.base`, t.base], [`desglose.${i}.cuota`, t.cuota]);
    if (t.cuotaRecargo) lista.push([`desglose.${i}.recargo`, t.cuotaRecargo]);
  });
  if (l.retencion) lista.push(['retencion.tipo', l.retencion.tipo], ['retencion.importe', l.retencion.importe]);
  lista.push(
    ['totales.base', l.totales.base],
    ['totales.cuotaIva', l.totales.cuotaIva],
    ['totales.totalFactura', l.totales.totalFactura],
    ['totales.totalAPagar', l.totales.totalAPagar],
    ['iban', l.iban],
    ['concepto', l.concepto],
  );
  if (l.rectificativa) lista.push(['rectificativa.numeroRectificada', l.rectificativa.numeroRectificada]);
  return lista;
}

const valorLeido = (c: Campo<unknown>): string | number | null => (typeof c.valor === 'string' || typeof c.valor === 'number' ? c.valor : null);

/** Une el estado por confianza y las validaciones, campo a campo. */
export function combinar(l: LecturaNormalizada, validaciones: ResultadoValidacion[]): ResultadoValidacionLectura {
  const campos: Partial<Record<CampoId, EstadoCampo>> = {};
  const vacios = new Map<CampoId, Campo<unknown>>();
  for (const [id, c] of camposDeLectura(l)) {
    vacios.set(id, c);
    if (c.valor === null && !c.motivo) continue;
    const { nivel, motivo } = estadoPorConfianza(c);
    campos[id] = { estado: nivel, confianza: c.confianza, fuente: c.fuente, valorLeido: valorLeido(c), motivos: motivo ? [motivo] : [] };
  }
  for (const val of validaciones) {
    for (const id of val.campos) {
      const c = vacios.get(id);
      const e = (campos[id] ??= { estado: 'ok', confianza: c?.confianza ?? null, fuente: c?.fuente ?? 'calculado', valorLeido: c ? valorLeido(c) : null, motivos: [] });
      e.estado = peor(e.estado, val.nivel);
      if (!e.motivos.includes(val.mensaje)) e.motivos.push(val.mensaje);
      if (val.nivel !== 'ok' && !(e.codigos ??= []).includes(val.codigo)) e.codigos.push(val.codigo);
      if (val.sugerencia && !e.sugerencia) e.sugerencia = val.sugerencia;
    }
  }
  // El tipo de IVA de cada tramo, para que la pantalla diga "Base del 21 %".
  l.desglose.forEach((t, i) => {
    for (const parte of ['base', 'cuota', 'recargo'] as const) {
      const e = campos[`desglose.${i}.${parte}`];
      if (e) e.tipoIva = t.tipoIva;
    }
  });
  // Sugerencias del QR.
  for (const d of l.qr?.diferencias ?? []) {
    const e = campos[CAMPO_QR[d.campo]];
    if (e) e.sugerencia = `El QR dice ${d.campo === 'importe' ? eur(Number(d.enQr)) : d.campo === 'fecha' ? ddmmaaaa(d.enQr) : d.enQr}`;
  }
  let estado: NivelValidacion = 'ok';
  for (const e of Object.values(campos)) if (e) estado = peor(estado, e.estado);
  for (const val of validaciones) if (val.campos.length === 0) estado = peor(estado, val.nivel);
  return { campos, validaciones, estado };
}

/** Valida una lectura: V01-V22 y el estado de cada campo. */
export async function validarLectura(l: LecturaNormalizada, ctx: ContextoValidacion): Promise<ResultadoValidacionLectura> {
  const validaciones = [...validacionesSincronas(l, ctx), ...(await v13Periodo(l, ctx))];
  return combinar(l, validaciones);
}
