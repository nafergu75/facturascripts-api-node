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
import { MONEDAS_FACTURA_ACTIVAS } from '../../domain/divisas';
import { TIPOS_IVA_GASTO } from '../../domain/factura-gasto.model';
import { prefijoNifIvaUe, validarFormatoNifIvaUe } from '../../domain/tipo-operacion.model';
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

export interface ContextoValidacion {
  lector: Lector;
  /** NIF de la empresa (LegalConfig.nif), o null si no lo tiene. */
  nifEmpresa: string | null;
  empresaEspanola: boolean;
  monedaCuenta: string;
  /** AAAA-MM-DD, hora de Madrid. */
  hoy: string;
  periodoAbierto: (fecha: string) => Promise<boolean>;
  duplicado: { factura: { numeroCompleto: string } | null; archivo: { fecha: string } | null };
}

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
  const lista = tipos.map((t) => `del ${pct(t)}`);
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

/** Motivo por el que el NIF no vale, o null. Un NIF-IVA de otro pais de la UE solo se mira el formato. */
export function motivoNifNoValido(nif: string, empresaEspanola: boolean): string | null {
  const ue = prefijoNifIvaUe(nif);
  if (ue && ue.pais !== 'ES') return validarFormatoNifIvaUe(nif) ? null : `El NIF-IVA ${nif} no tiene un formato válido.`;
  if (!empresaEspanola && !/^(ES)?[0-9XYZKLMA-HJNPQRSUVW]\d{7}[0-9A-Z]$/i.test(nif)) return null; // NIF de fuera (EIN...)
  const r = validarNifEspanol(nif);
  return r.valido ? null : (r.motivo ?? 'El NIF no es válido.');
}

function v07NifEmisor(l: LecturaNormalizada, ctx: ContextoValidacion): ResultadoValidacion[] {
  const nif = l.emisor.nif.valor;
  if (!nif) {
    if (ctx.lector !== 'GASTO') return [];
    return [v('NIF_EMISOR', ctx.empresaEspanola ? 'error' : 'revisar', ['emisor.nif'], 'No se ha podido leer el NIF del proveedor.')];
  }
  const motivo = motivoNifNoValido(nif, ctx.empresaEspanola);
  return motivo ? [v('NIF_EMISOR', 'error', ['emisor.nif'], motivo)] : [];
}

function v08NifReceptor(l: LecturaNormalizada, ctx: ContextoValidacion): ResultadoValidacion[] {
  const nif = l.receptor.nif.valor;
  if (!nif) {
    if (ctx.lector === 'VENTA') return [v('NIF_RECEPTOR', 'error', ['receptor.nif'], 'Falta el NIF del cliente: es obligatorio en una factura de ingreso.')];
    // La lectura de gastos con Claude no pregunta por el cliente: que falte no dice nada.
    if (l.receptor.nif.fuente === 'claude') return [];
    if (['simplificada', 'ticket', 'recibo'].includes(l.tipoDocumento.valor ?? '')) return [];
    return [v('NIF_RECEPTOR', 'revisar', ['receptor.nif'], 'La factura no lleva el NIF de la empresa como cliente: compruébalo.')];
  }
  const motivo = motivoNifNoValido(nif, ctx.empresaEspanola);
  return motivo ? [v('NIF_RECEPTOR', 'error', ['receptor.nif'], motivo)] : [];
}

function v09Empresa(l: LecturaNormalizada, ctx: ContextoValidacion): ResultadoValidacion[] {
  if (!ctx.nifEmpresa) return [];
  const empresa = normalizarNif(ctx.nifEmpresa);
  const emisor = l.emisor.nif.valor ? normalizarNif(l.emisor.nif.valor) : null;
  const receptor = l.receptor.nif.valor ? normalizarNif(l.receptor.nif.valor) : null;
  const r: ResultadoValidacion[] = [];
  if (ctx.lector === 'GASTO') {
    if (emisor === empresa) r.push(v('EMPRESA', 'error', ['emisor.nif'], 'Parece una factura emitida por la empresa: léela en el lector de ventas.'));
    else if (receptor && receptor !== empresa) r.push(v('EMPRESA', 'revisar', ['receptor.nif'], `La factura no va a nombre de la empresa (NIF del cliente: ${receptor}).`));
  } else {
    if (receptor === empresa) r.push(v('EMPRESA', 'error', ['receptor.nif'], 'Parece una factura recibida por la empresa: léela en el lector de gastos.'));
    else if (emisor && emisor !== empresa) r.push(v('EMPRESA', 'revisar', ['emisor.nif'], `La factura no la ha emitido la empresa (NIF del emisor: ${emisor}).`));
  }
  return r;
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

function v19v20TipoDocumento(l: LecturaNormalizada): ResultadoValidacion[] {
  const tipo = l.tipoDocumento.valor;
  if (tipo === 'rectificativa') {
    const n = l.rectificativa?.numeroRectificada.valor;
    return [v('RECTIFICATIVA', 'error', ['tipoDocumento'], `Es una factura rectificativa${n ? ` (rectifica a la ${n})` : ''}. Todavía no se puede registrar con el lector.`)];
  }
  if (importesNegativos(l)) return [v('RECTIFICATIVA', 'error', ['tipoDocumento', 'totales.totalAPagar'], MENSAJE_IMPORTES_NEGATIVOS)];
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
    ...v19v20TipoDocumento(l),
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
