/**
 * Traslado del plan contable de 2026 (o del ultimo ejercicio llevado en otro
 * programa) a la empresa: R3 de subcuentas-terceros.md.
 *
 *  - Se crean TODAS las cuentas y subcuentas del fichero que no estan en el
 *    plan de la empresa, tambien las de saldo cero, con su nombre y su codigo
 *    tal cual (sin cambiar la longitud), colgando de su cuenta madre (la mas
 *    larga que sea prefijo suyo, del fichero o del plan).
 *  - La longitud de las subcuentas de la empresa pasa a ser la del plan (la mas
 *    habitual entre sus subcuentas de clientes y proveedores; si no tiene,
 *    entre todas sus subcuentas de 7 a 10 digitos) si aun no hay subcuentas de
 *    tercero de otra longitud que lo impidan. Las nuevas fichas siguen la misma
 *    numeracion (siguiente libre).
 *  - Las subcuentas de clientes y proveedores (las que cuelgan de 430, 400 o
 *    410, o de sus cuentas en euros 4300, 4000 y 4100) se enlazan a fichas por
 *    NIF (del fichero o de los listados de clientes y proveedores): a la ficha
 *    que ya existe o a una nueva creada con ese NIF (solo si el usuario puede
 *    dar de alta clientes o proveedores). Sin NIF se propone la ficha con el
 *    mismo nombre (sin tildes ni forma juridica) si hay una sola; si no, quedan
 *    en el plan para enlazarlas despues (enlazarSubcuenta). Una ficha que ya
 *    tenia una subcuenta sin movimientos la cambia por la del plan; la antigua
 *    queda inactiva. Las de 4009, 4309... (facturas pendientes, moneda
 *    extranjera) se traen como cuentas y no se enlazan.
 *
 * Sin estado entre peticiones: la vista previa y la confirmacion hacen el mismo
 * calculo con los mismos datos.
 */
import { randomUUID } from 'crypto';
import { prisma, type TransaccionBD } from '../../config/database';
import { PGC_BASE } from '../../domain/pgc-model';
import { paisDelCliente } from '../../domain/tipo-operacion.model';
import { badRequest, conflict, forbidden, notFound } from '../../utils/http-errors';
import { normalizarNif } from '../../utils/nif';
import { leerFilasArchivo } from '../extractoBancario.service';
import { asegurarPlanContableEmpresa } from '../chart-of-accounts.service';
import { esLongitudSubcuentasValida, esSubcuentaDeTercero, longitudEnUso } from '../terceros/numeracion';
import {
  asegurarSubcuentaEnPlan,
  asignarSubcuentasProveedor,
  conReintentoSubcuenta,
  longitudSubcuentasEmpresa,
  longitudSubcuentasGuardada,
  type TipoFicha,
} from '../terceros/subcuentas';
import { OPCIONES_TX } from './asientosEnBloque';
import { cuentaYNombre, normalizarCuenta, normalizarTitulo, texto } from './lectorContable';

// ---------------------------------------------------------------------------
// Lectura del fichero del plan
// ---------------------------------------------------------------------------

export interface CuentaDelPlan {
  codigo: string;
  nombre: string;
  /** NIF del titular (solo en las subcuentas de clientes y proveedores que lo traen). */
  nif?: string;
}

/** Fila de un listado de clientes o proveedores del programa anterior. */
export interface TerceroDelListado {
  subcuenta?: string;
  nif?: string;
  nombre?: string;
}

export interface LecturaPlan {
  formato: string;
  filas: number;
  cuentas: CuentaDelPlan[];
  /** Columnas reconocidas (indice de cada una) o null si se leyo sin titulos. */
  columnas: { cuenta: number; nombre: number | null; nif: number | null } | null;
  avisos: string[];
}

const PATRON_CUENTA = /^(cuenta|subcuenta|cod|codigo|cta|n cuenta|num cuenta|numero cuenta|codigo cuenta|cod cuenta|codigo subcuenta|cod subcuenta|codsubcuenta|account|code)$/;
const PATRON_NOMBRE = /^(descripcion|nombre|titulo|denominacion|nombre cuenta|descripcion cuenta|nombre subcuenta|descripcion subcuenta|titulo cuenta|description|name|razon social)$/;
const PATRON_NIF = /^(nif|cif|nif cif|cif nif|dni|nie|nif iva|vat|tax id|n i f|c i f|identificacion fiscal)$/;

/** Plan de cuentas desde las filas de un Excel o CSV (codigo, nombre y, si lo trae, NIF). */
export function leerPlanDeFilas(filas: unknown[][], formato = 'xlsx'): LecturaPlan {
  const avisos: string[] = [];
  let cab: { fila: number; cuenta: number; nombre: number | null; nif: number | null } | null = null;
  for (let i = 0; i < Math.min(filas.length, 40) && !cab; i++) {
    const titulos = (filas[i] ?? []).map(normalizarTitulo);
    const cuenta = titulos.findIndex((t) => PATRON_CUENTA.test(t));
    if (cuenta < 0) continue;
    const nombre = titulos.findIndex((t, j) => j !== cuenta && PATRON_NOMBRE.test(t));
    const nif = titulos.findIndex((t, j) => j !== cuenta && j !== nombre && PATRON_NIF.test(t));
    cab = { fila: i, cuenta, nombre: nombre >= 0 ? nombre : null, nif: nif >= 0 ? nif : null };
  }
  const cuentas = new Map<string, CuentaDelPlan>();
  const inicio = cab ? cab.fila + 1 : 0;
  for (let i = inicio; i < filas.length; i++) {
    const fila = filas[i] ?? [];
    let codigo: string | null = null;
    let nombre = '';
    if (cab) {
      codigo = normalizarCuenta(fila[cab.cuenta]);
      if (!codigo) {
        // «4300001 Cliente SL» en una sola celda.
        const cyn = cuentaYNombre(fila[cab.cuenta]);
        if (cyn) ({ codigo, nombre } = cyn);
      }
      if (cab.nombre !== null && texto(fila[cab.nombre])) nombre = texto(fila[cab.nombre]);
    } else {
      // Sin titulos: la primera celda con un codigo, y el nombre en la siguiente (o en la misma).
      for (let j = 0; j < Math.min(fila.length, 4) && !codigo; j++) {
        codigo = normalizarCuenta(fila[j]);
        if (codigo) nombre = texto(fila[j + 1]);
        else {
          const cyn = cuentaYNombre(fila[j]);
          if (cyn) ({ codigo, nombre } = cyn);
        }
      }
    }
    if (!codigo) continue;
    const nif = cab?.nif !== null && cab?.nif !== undefined ? normalizarNif(fila[cab.nif]) : '';
    if (!cuentas.has(codigo)) cuentas.set(codigo, { codigo, nombre: nombre.slice(0, 190), ...(nif ? { nif } : {}) });
  }
  if (!cuentas.size) {
    throw badRequest('No encuentro cuentas en el fichero: tiene que traer una columna con el código de cada cuenta (Cuenta, Subcuenta o Código) y su nombre.');
  }
  if (!cab) avisos.push('El fichero no trae títulos de columna: se toma el primer código de cada fila como la cuenta y lo que le sigue como su nombre.');
  return { formato, filas: filas.length, cuentas: [...cuentas.values()].sort((a, b) => a.codigo.localeCompare(b.codigo)), columnas: cab && { cuenta: cab.cuenta, nombre: cab.nombre, nif: cab.nif }, avisos };
}

export function leerPlan(contenido: Buffer, nombreArchivo: string): LecturaPlan {
  const { formato, filas } = leerFilasArchivo(contenido, nombreArchivo);
  return leerPlanDeFilas(filas, formato);
}

/** Cuentas recibidas como JSON: [{ codigo, nombre, nif? }]. */
export function cuentasPlanDesdeJson(valor: unknown): CuentaDelPlan[] {
  const lista = typeof valor === 'string' ? parsear(valor) : valor;
  if (!Array.isArray(lista)) throw badRequest('Envía el fichero del plan o la lista de cuentas (codigo y nombre).');
  const out = new Map<string, CuentaDelPlan>();
  for (const item of lista as Array<Record<string, unknown>>) {
    const codigo = normalizarCuenta(item?.codigo);
    if (!codigo) throw badRequest(`Código de cuenta no válido: ${JSON.stringify(item?.codigo ?? null).slice(0, 40)}`);
    const nif = item?.nif ? normalizarNif(item.nif) : '';
    if (!out.has(codigo)) out.set(codigo, { codigo, nombre: String(item?.nombre ?? '').trim().slice(0, 190), ...(nif ? { nif } : {}) });
  }
  return [...out.values()].sort((a, b) => a.codigo.localeCompare(b.codigo));
}

/** Listado de clientes o proveedores como JSON: [{ subcuenta, nif, nombre }]. */
export function tercerosDesdeJson(valor: unknown): TerceroDelListado[] {
  if (valor === undefined || valor === null || valor === '') return [];
  const lista = typeof valor === 'string' ? parsear(valor) : valor;
  if (!Array.isArray(lista)) throw badRequest('El listado de clientes y proveedores tiene que ser una lista.');
  return (lista as Array<Record<string, unknown>>).map((t) => ({
    subcuenta: normalizarCuenta(t?.subcuenta) ?? undefined,
    nif: t?.nif ? normalizarNif(t.nif) : undefined,
    nombre: t?.nombre ? String(t.nombre).trim().slice(0, 190) : undefined,
  }));
}

function parsear(v: string): unknown {
  try {
    return JSON.parse(v);
  } catch {
    throw badRequest('Los datos enviados no son un JSON válido.');
  }
}

// ---------------------------------------------------------------------------
// Analisis (vista previa)
// ---------------------------------------------------------------------------

export type AccionTercero = 'enlazar' | 'crear' | 'pendiente' | 'ya-enlazada' | 'no-se-enlaza';

export interface SubcuentaTercero {
  codigo: string;
  nombre: string;
  tipo: TipoFicha;
  nif: string | null;
  accion: AccionTercero;
  /** Ficha con la que se enlaza (la que existe o la que se crea). */
  ficha: { id: string | null; nombre: string } | null;
  /** Subcuenta anterior de la ficha que se sustituye (queda inactiva). */
  sustituye?: string;
  motivo?: string;
}

export interface CuentaNuevaPlan {
  codigo: string;
  nombre: string;
  madre: string;
}

export interface VistaPlan {
  lectura: Omit<LecturaPlan, 'cuentas'> | null;
  cuentasLeidas: number;
  cuentasNuevas: CuentaNuevaPlan[];
  cuentasExistentes: number;
  /** Cuentas que no se importan (grupos 8 y 9, o sin cuenta madre en el PGC). */
  omitidas: Array<{ codigo: string; motivo: string }>;
  longitud: { delPlan: number | null; actual: number; seFija: boolean; motivo: string | null };
  terceros: SubcuentaTercero[];
  resumen: { enlazar: number; crear: number; pendientes: number; yaEnlazadas: number; noSeEnlazan: number };
  errores: string[];
  avisos: string[];
  puedeConfirmar: boolean;
}

const PREFIJO_TIPO: Record<string, TipoFicha> = { '430': 'cliente', '400': 'proveedor', '410': 'proveedor' };

/**
 * Cuentas de las que cuelgan las subcuentas de clientes y proveedores: las de 3
 * digitos y, en un plan PGC completo, sus cuentas «en euros» de 4 digitos.
 */
export const MADRES_TERCERO = ['430', '400', '410', '4300', '4000', '4100'];

/** Si el usuario puede dar de alta fichas de cliente (ventas:write) y de proveedor (compras:write). */
export interface PermisosAlta {
  cliente: boolean;
  proveedor: boolean;
}
const TODOS_PERMISOS: PermisosAlta = { cliente: true, proveedor: true };
const TEXTO_SIN_PERMISO: Record<TipoFicha, string> = {
  cliente: 'No tienes permiso para dar de alta clientes (Ventas)',
  proveedor: 'No tienes permiso para dar de alta proveedores (Compras)',
};

const FORMAS_JURIDICAS = new Set([
  'SL', 'SA', 'SLU', 'SAU', 'SLL', 'SLP', 'SLNE', 'SAL', 'SC', 'SCP', 'CB', 'SCOOP', 'SCCL', 'COOP', 'SRL',
  'SOCIEDADLIMITADA', 'SOCIEDADANONIMA', 'SOCIEDADLIMITADAUNIPERSONAL', 'SOCIEDADANONIMAUNIPERSONAL',
]);

/** Nombre para comparar: sin tildes, mayusculas, sin signos y sin la forma juridica final («Valencia, S.L.» = «VALENCIA»). */
export function nombreComparable(nombre: string | null | undefined): string {
  let palabras = String(nombre ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/\./g, '')
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  for (let quitada = true; quitada && palabras.length > 1; ) {
    quitada = false;
    for (const k of [3, 2, 1]) {
      if (palabras.length > k && FORMAS_JURIDICAS.has(palabras.slice(-k).join(''))) {
        palabras = palabras.slice(0, -k);
        quitada = true;
        break;
      }
    }
  }
  return palabras.join(' ');
}

function porNombre<T extends { nombreFiscal: string }>(fichas: T[]): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const f of fichas) {
    const k = nombreComparable(f.nombreFiscal);
    if (!k) continue;
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(f);
  }
  return m;
}

type FichaCliente = { id: string; nombreFiscal: string; nifCif: string; subcuenta430: string | null };
type FichaProveedor = { id: string; nombreFiscal: string; nifCif: string; subcuenta400: string | null; subcuenta410: string | null };

interface Contexto {
  plan: Map<string, { nombre: string; activo: boolean }>;
  clientes: FichaCliente[];
  proveedores: FichaProveedor[];
  conApuntes: Set<string>;
  longitudActual: number;
  longitudGuardada: number | null;
}

async function cargarContexto(db: TransaccionBD | typeof prisma, companyId: string, codigos: string[]): Promise<Contexto> {
  const [planEmpresa, clientes, proveedores, longitudActual, longitudGuardada] = await Promise.all([
    db.chartOfAccounts.findMany({ where: { companyId }, select: { codigo: true, nombre: true, activo: true } }),
    db.customer.findMany({ where: { companyId }, select: { id: true, nombreFiscal: true, nifCif: true, subcuenta430: true }, orderBy: { createdAt: 'asc' } }),
    db.supplier.findMany({ where: { companyId }, select: { id: true, nombreFiscal: true, nifCif: true, subcuenta400: true, subcuenta410: true }, orderBy: { createdAt: 'asc' } }),
    longitudSubcuentasEmpresa(companyId, db),
    longitudSubcuentasGuardada(companyId, db),
  ]);
  const plan = new Map<string, { nombre: string; activo: boolean }>();
  for (const n of PGC_BASE) plan.set(n.code, { nombre: n.name, activo: true });
  for (const c of planEmpresa) plan.set(c.codigo, { nombre: c.nombre, activo: c.activo });
  // Subcuentas de las fichas con apuntes: esas no se sustituyen.
  const deFichas = [
    ...clientes.map((c) => c.subcuenta430),
    ...proveedores.flatMap((p) => [p.subcuenta400, p.subcuenta410]),
  ].filter((c): c is string => !!c);
  const mirar = [...new Set([...deFichas, ...codigos.filter(esSubcuentaDeTercero)])];
  const conApuntes = new Set(
    mirar.length
      ? (await db.journalEntryLine.groupBy({ by: ['accountCode'], where: { companyId, accountCode: { in: mirar } } })).map((g) => g.accountCode)
      : [],
  );
  return { plan, clientes, proveedores, conApuntes, longitudActual, longitudGuardada };
}

/** Cuenta madre: la mas larga que sea prefijo suyo, entre las del plan y las del fichero (minimo 3 digitos). */
function madreDe(codigo: string, conocidas: Set<string>): string | null {
  for (let l = codigo.length - 1; l >= 3; l--) {
    const p = codigo.slice(0, l);
    if (conocidas.has(p)) return p;
  }
  return null;
}

/** Longitud del plan: la de sus subcuentas de clientes y proveedores; si no tiene, la de sus subcuentas de 7 a 10 digitos. */
export function longitudDelPlan(codigos: string[], esTercero: (c: string) => boolean): number | null {
  const terceros = longitudEnUso(codigos.filter(esTercero));
  if (terceros) return terceros;
  const cuenta = new Map<number, number>();
  for (const c of codigos) if (esLongitudSubcuentasValida(c.length)) cuenta.set(c.length, (cuenta.get(c.length) ?? 0) + 1);
  let mejor: number | null = null;
  for (const [l, n] of cuenta) if (mejor === null || n > cuenta.get(mejor)!) mejor = l;
  return mejor;
}

const nifValido = (n: string | null | undefined): n is string => !!n && /^[A-Z0-9]{5,15}$/.test(n);

/** Elige el texto en singular o en plural segun el numero: segun(1, 'trae', 'traen'). */
const segun = (n: number, singular: string, plural: string) => (n === 1 ? singular : plural);

interface Analisis {
  vista: VistaPlan;
  cuentasValidas: CuentaDelPlan[];
}

async function analizar(
  db: TransaccionBD | typeof prisma,
  companyId: string,
  cuentasEntrada: CuentaDelPlan[],
  listado: TerceroDelListado[],
  lectura: Omit<LecturaPlan, 'cuentas'> | null,
  permisos: PermisosAlta = TODOS_PERMISOS,
): Promise<Analisis> {
  const errores: string[] = [];
  const avisos: string[] = [...(lectura?.avisos ?? [])];
  const ctx = await cargarContexto(db, companyId, cuentasEntrada.map((c) => c.codigo));

  // 1. Cuentas: grupos 1 a 7 con su madre; las de 8 y 9 no se usan en la app.
  const omitidas: VistaPlan['omitidas'] = [];
  const conocidas = new Set(ctx.plan.keys());
  const validas: CuentaDelPlan[] = [];
  for (const c of [...cuentasEntrada].sort((a, b) => a.codigo.length - b.codigo.length || a.codigo.localeCompare(b.codigo))) {
    if (!/^[1-7]/.test(c.codigo)) {
      omitidas.push({ codigo: c.codigo, motivo: 'Grupos 8 y 9: la app no los usa.' });
      continue;
    }
    if (c.codigo.length > 3 && !madreDe(c.codigo, conocidas)) {
      omitidas.push({ codigo: c.codigo, motivo: `No encaja en el PGC (no existe la cuenta ${c.codigo.slice(0, 3)}).` });
      continue;
    }
    conocidas.add(c.codigo);
    validas.push(c);
  }
  if (omitidas.length) avisos.push(`${omitidas.length} ${segun(omitidas.length, 'cuenta no se importa', 'cuentas no se importan')} (grupos 8 y 9 o fuera del PGC): mira la lista.`);
  const nuevas: CuentaNuevaPlan[] = [];
  const existentesConOtroNombre: string[] = [];
  let existentes = 0;
  const conocidasPlan = new Set(ctx.plan.keys());
  for (const c of validas) {
    const ya = ctx.plan.get(c.codigo);
    if (ya) {
      existentes++;
      if (c.nombre && ya.nombre !== c.nombre && c.codigo.length > 3) existentesConOtroNombre.push(c.codigo);
      continue;
    }
    if (c.codigo.length <= 3) {
      omitidas.push({ codigo: c.codigo, motivo: 'Cuenta de 3 dígitos que no está en el PGC de PYMES.' });
      continue;
    }
    const madre = madreDe(c.codigo, conocidasPlan)!;
    conocidasPlan.add(c.codigo);
    nuevas.push({ codigo: c.codigo, nombre: c.nombre || `${ctx.plan.get(madre)?.nombre ?? nuevas.find((n) => n.codigo === madre)?.nombre ?? 'Cuenta'} (${c.codigo})`, madre });
  }
  if (existentesConOtroNombre.length) {
    avisos.push(
      `${existentesConOtroNombre.length} ${segun(existentesConOtroNombre.length, 'subcuenta ya estaba en el plan con otro nombre: se deja el nombre que tiene', 'subcuentas ya estaban en el plan con otro nombre: se deja el nombre que tienen')} (${existentesConOtroNombre.slice(0, 5).join(', ')}${existentesConOtroNombre.length > 5 ? '…' : ''}).`,
    );
  }

  // 2. Subcuentas de clientes y proveedores: las 430/400/410 que cuelgan de ellas o de 4300/4000/4100.
  const madreFinal = new Map<string, string | null>();
  const todas = new Set([...ctx.plan.keys(), ...validas.map((c) => c.codigo)]);
  for (const c of validas) madreFinal.set(c.codigo, madreDe(c.codigo, todas));
  const esTercero = (codigo: string) => esSubcuentaDeTercero(codigo) && MADRES_TERCERO.includes(madreFinal.get(codigo) ?? codigo.slice(0, 3));
  const subcuentas = validas.filter((c) => esTercero(c.codigo));

  // 3. Longitud: la del plan, si no la impiden las subcuentas que ya tienen las fichas.
  const delPlan = longitudDelPlan(validas.map((c) => c.codigo).filter((c) => c.length > 3), esTercero);

  // 4. Enlaces por NIF.
  const nifDeListado = new Map<string, TerceroDelListado>();
  for (const t of listado) if (t.subcuenta) nifDeListado.set(t.subcuenta, t);
  const clientesPorNif = new Map(ctx.clientes.map((c) => [normalizarNif(c.nifCif), c]));
  const proveedoresPorNif = new Map(ctx.proveedores.map((p) => [normalizarNif(p.nifCif), p]));
  const clientesPorNombre = porNombre(ctx.clientes);
  const proveedoresPorNombre = porNombre(ctx.proveedores);
  const fichaDeCodigo = new Map<string, { tipo: TipoFicha; id: string; nombre: string }>();
  for (const c of ctx.clientes) if (c.subcuenta430) fichaDeCodigo.set(c.subcuenta430, { tipo: 'cliente', id: c.id, nombre: c.nombreFiscal });
  for (const p of ctx.proveedores) {
    if (p.subcuenta400) fichaDeCodigo.set(p.subcuenta400, { tipo: 'proveedor', id: p.id, nombre: p.nombreFiscal });
    if (p.subcuenta410) fichaDeCodigo.set(p.subcuenta410, { tipo: 'proveedor', id: p.id, nombre: p.nombreFiscal });
  }
  /** Prefijo ya enlazado en este fichero, por ficha («cliente:id:430»): una ficha, una subcuenta por prefijo. */
  const usado = new Map<string, string>();
  /** Fichas nuevas por NIF (dos subcuentas 400N y 410N del mismo NIF van a la misma). */
  const nuevasPorNif = new Map<string, string>();

  const terceros: SubcuentaTercero[] = [];
  /** Pendientes porque haria falta una ficha nueva y no hay permiso para darla de alta. */
  const sinPermiso: Record<TipoFicha, number> = { cliente: 0, proveedor: 0 };
  for (const c of subcuentas) {
    const prefijo = c.codigo.slice(0, 3);
    const tipo = PREFIJO_TIPO[prefijo];
    const extra = nifDeListado.get(c.codigo);
    const nif = c.nif || extra?.nif || null;
    const nombre = c.nombre || extra?.nombre || `Subcuenta ${c.codigo}`;
    const base = { codigo: c.codigo, nombre, tipo, nif: nifValido(nif) ? nif : null };
    const ya = fichaDeCodigo.get(c.codigo);
    if (ya) {
      // La ficha que ya la tiene en la app es otra (otro NIF): no se mueve sola.
      const nifFicha = normalizarNif(ya.tipo === 'cliente' ? ctx.clientes.find((x) => x.id === ya.id)?.nifCif : ctx.proveedores.find((x) => x.id === ya.id)?.nifCif);
      if (nifValido(nif) && nifFicha && nifFicha !== nif) {
        terceros.push({
          ...base,
          accion: 'no-se-enlaza',
          ficha: { id: ya.id, nombre: ya.nombre },
          motivo: `En la app la ${c.codigo} ya es de ${ya.nombre} (NIF ${nifFicha}) y en el plan anterior es de otro NIF (${nif}): revísalo.`,
        });
        continue;
      }
      terceros.push({ ...base, accion: 'ya-enlazada', ficha: { id: ya.id, nombre: ya.nombre } });
      continue;
    }
    let ficha: FichaCliente | FichaProveedor | undefined;
    let motivoNombre: string | undefined;
    if (!nifValido(nif)) {
      // Sin NIF (o con uno no valido): la ficha con el mismo nombre, si solo hay una.
      const nombreFichero = c.nombre || extra?.nombre || '';
      const candidatas: Array<FichaCliente | FichaProveedor> = nombreFichero
        ? ((tipo === 'cliente' ? clientesPorNombre : proveedoresPorNombre).get(nombreComparable(nombreFichero)) ?? [])
        : [];
      if (candidatas.length !== 1) {
        const sinNif = nif ? `El NIF «${nif}» no es válido` : 'Sin NIF';
        terceros.push({
          ...base,
          accion: 'pendiente',
          ficha: null,
          motivo: candidatas.length > 1 ? `${sinNif} y hay ${candidatas.length} fichas con ese nombre: enlázala a mano.` : nif ? `${sinNif}: enlázala a mano.` : 'Sin NIF: enlázala a una ficha después.',
        });
        continue;
      }
      ficha = candidatas[0];
      motivoNombre = `Coincide por nombre con la ficha ${ficha.nombreFiscal}: compruébalo antes de confirmar.`;
    } else {
      ficha = tipo === 'cliente' ? clientesPorNif.get(nif) : proveedoresPorNif.get(nif);
    }
    const clave = (id: string) => `${tipo}:${id}:${prefijo}`;
    if (!ficha && nifValido(nif)) {
      if (!permisos[tipo]) {
        sinPermiso[tipo]++;
        terceros.push({ ...base, accion: 'pendiente', ficha: null, motivo: `${TEXTO_SIN_PERMISO[tipo]}: enlázala a una ficha que ya exista o pide al administrador que la cree.` });
        continue;
      }
      const claveNueva = `${tipo}:${nif}`;
      const otra = nuevasPorNif.get(`${claveNueva}:${prefijo}`);
      if (otra) {
        terceros.push({ ...base, accion: 'no-se-enlaza', ficha: null, motivo: `El NIF ${nif} ya va con la subcuenta ${otra}: queda sin enlazar.` });
        continue;
      }
      nuevasPorNif.set(`${claveNueva}:${prefijo}`, c.codigo);
      terceros.push({ ...base, accion: 'crear', ficha: { id: null, nombre } });
      continue;
    }
    if (!ficha) continue;
    if (usado.has(clave(ficha.id))) {
      terceros.push({ ...base, accion: 'no-se-enlaza', ficha: { id: ficha.id, nombre: ficha.nombreFiscal }, motivo: `${ficha.nombreFiscal} ya va con la subcuenta ${usado.get(clave(ficha.id))}: queda sin enlazar.` });
      continue;
    }
    const actual = tipo === 'cliente' ? (ficha as FichaCliente).subcuenta430 : prefijo === '400' ? (ficha as FichaProveedor).subcuenta400 : (ficha as FichaProveedor).subcuenta410;
    if (actual && actual !== c.codigo && ctx.conApuntes.has(actual)) {
      terceros.push({
        ...base,
        accion: 'no-se-enlaza',
        ficha: { id: ficha.id, nombre: ficha.nombreFiscal },
        motivo: `${ficha.nombreFiscal} ya tiene la subcuenta ${actual} con movimientos, así que la ${c.codigo} se trae sin enlazar. Lo que importes en la ${c.codigo} (como su saldo de apertura) quedará ahí y sus facturas nuevas seguirán en la ${actual}.`,
      });
      continue;
    }
    usado.set(clave(ficha.id), c.codigo);
    terceros.push({
      ...base,
      accion: 'enlazar',
      ficha: { id: ficha.id, nombre: ficha.nombreFiscal },
      ...(actual && actual !== c.codigo ? { sustituye: actual } : {}),
      ...(motivoNombre ? { motivo: motivoNombre } : {}),
    });
  }

  // Longitud: se fija si, tras los enlaces, ninguna ficha se queda con una subcuenta de otra longitud.
  let longitud: VistaPlan['longitud'] = { delPlan, actual: ctx.longitudActual, seFija: false, motivo: null };
  if (delPlan) {
    const sustituidas = new Set(terceros.map((t) => t.sustituye).filter(Boolean));
    const quedan = [...fichaDeCodigo.keys()].filter((c) => !sustituidas.has(c) && c.length !== delPlan);
    if (quedan.length && ctx.longitudActual !== delPlan) {
      longitud = {
        ...longitud,
        motivo: `Tu plan anterior usa subcuentas de ${delPlan} dígitos y aquí ya hay clientes o proveedores con ${ctx.longitudActual} (${quedan.slice(0, 3).join(', ')}). Si sigues, convivirán las dos longitudes: las subcuentas del plan anterior se traen con ${delPlan} dígitos y las de los clientes y proveedores nuevos seguirán con ${ctx.longitudActual}.`,
      };
      // Sin repetirlo en avisos: la pantalla ya ensena longitud.motivo en su recuadro.
    } else if (ctx.longitudGuardada !== delPlan) {
      longitud = { ...longitud, seFija: true };
    }
  } else {
    longitud.motivo = `El plan no trae subcuentas de 7 a 10 dígitos: la longitud sigue en ${ctx.longitudActual}.`;
  }
  const noTercero = validas.filter((c) => /^(4004|4009|4104|4109|4304|4309)\d+$/.test(c.codigo)).map((c) => c.codigo);
  if (noTercero.length) {
    avisos.push(
      `${noTercero.length} ${segun(noTercero.length, 'subcuenta', 'subcuentas')} de 4004, 4009, 4104, 4109, 4304 o 4309 (${noTercero.slice(0, 3).join(', ')}${noTercero.length > 3 ? '…' : ''}) se ${segun(noTercero.length, 'trae como cuenta, sin enlazarla', 'traen como cuentas, sin enlazarlas')} a ningún cliente ni proveedor.`,
    );
  }
  const otrasLongitudes = delPlan ? subcuentas.filter((c) => c.codigo.length !== delPlan).map((c) => c.codigo) : [];
  if (otrasLongitudes.length) {
    avisos.push(
      `${otrasLongitudes.length} ${segun(otrasLongitudes.length, 'subcuenta de cliente o proveedor tiene', 'subcuentas de clientes o proveedores tienen')} otra longitud (${otrasLongitudes.slice(0, 3).join(', ')}): se ${segun(otrasLongitudes.length, 'trae', 'traen')} tal cual.`,
    );
  }

  const resumen = {
    enlazar: terceros.filter((t) => t.accion === 'enlazar').length,
    crear: terceros.filter((t) => t.accion === 'crear').length,
    pendientes: terceros.filter((t) => t.accion === 'pendiente').length,
    yaEnlazadas: terceros.filter((t) => t.accion === 'ya-enlazada').length,
    noSeEnlazan: terceros.filter((t) => t.accion === 'no-se-enlaza').length,
  };
  // Las pendientes lo son por dos motivos distintos: sin NIF valido, o sin permiso para crear su ficha.
  const sinNif = resumen.pendientes - sinPermiso.cliente - sinPermiso.proveedor;
  if (sinNif) {
    avisos.push(
      `${sinNif} ${segun(sinNif, 'subcuenta de cliente o proveedor no trae', 'subcuentas de clientes o proveedores no traen')} un NIF válido: ${segun(sinNif, 'queda en el plan para enlazarla', 'quedan en el plan para enlazarlas')} después a su ficha.`,
    );
  }
  for (const tipo of ['cliente', 'proveedor'] as const) {
    const n = sinPermiso[tipo];
    if (!n) continue;
    const [una, varias, quien, area] =
      tipo === 'cliente' ? ['subcuenta de cliente', 'subcuentas de clientes', 'clientes', 'Ventas'] : ['subcuenta de proveedor', 'subcuentas de proveedores', 'proveedores', 'Compras'];
    avisos.push(
      `${n} ${segun(n, una, varias)} ${segun(n, 'necesita', 'necesitan')} una ficha nueva y no tienes permiso para dar de alta ${quien} (${area} «Modificar»): ${segun(n, 'queda', 'quedan')} en el plan para ${segun(n, 'enlazarla', 'enlazarlas')} a una ficha que ya exista, o para que el administrador ${segun(n, 'la cree', 'las cree')}.`,
    );
  }
  if (!validas.length) errores.push('El fichero no trae ninguna cuenta de los grupos 1 a 7.');

  return {
    vista: {
      lectura,
      cuentasLeidas: cuentasEntrada.length,
      cuentasNuevas: nuevas,
      cuentasExistentes: existentes,
      omitidas,
      longitud,
      terceros,
      resumen,
      errores,
      avisos,
      puedeConfirmar: errores.length === 0,
    },
    cuentasValidas: validas,
  };
}

export interface EntradaPlan {
  lectura?: LecturaPlan;
  cuentas?: CuentaDelPlan[];
  terceros?: TerceroDelListado[];
  /** Si puede crear fichas de cliente o proveedor (por defecto, si). */
  permisos?: PermisosAlta;
}

export async function previsualizarPlan(companyId: string, entrada: EntradaPlan): Promise<VistaPlan> {
  await asegurarPlanContableEmpresa(companyId);
  const { cuentas, lectura } = separar(entrada);
  return (await analizar(prisma, companyId, cuentas, entrada.terceros ?? [], lectura, entrada.permisos)).vista;
}

function separar(entrada: { lectura?: LecturaPlan; cuentas?: CuentaDelPlan[] }) {
  const cuentas = entrada.lectura?.cuentas ?? entrada.cuentas ?? [];
  if (!cuentas.length) throw badRequest('No hay cuentas que importar.');
  let lectura: Omit<LecturaPlan, 'cuentas'> | null = null;
  if (entrada.lectura) {
    const { cuentas: _c, ...resto } = entrada.lectura;
    lectura = resto;
  }
  return { cuentas, lectura };
}

// ---------------------------------------------------------------------------
// Confirmacion
// ---------------------------------------------------------------------------

export interface ResultadoPlan {
  vista: VistaPlan;
  cuentasCreadas: number;
  fichasEnlazadas: number;
  fichasCreadas: number;
  pendientes: number;
  longitudFijada: number | null;
}

const NOTA_PLAN = 'Traída del plan contable anterior (puesta en marcha).';

/** Crea las cuentas nuevas por orden de longitud: la madre siempre existe antes que sus hijas. */
async function crearCuentas(tx: TransaccionBD, companyId: string, nuevas: CuentaNuevaPlan[]): Promise<number> {
  if (!nuevas.length) return 0;
  const madres = new Map(
    (await tx.chartOfAccounts.findMany({ where: { companyId, codigo: { in: [...new Set(nuevas.map((n) => n.madre))] } } })).map((m) => [m.codigo, m]),
  );
  const yaEstan = new Set((await tx.chartOfAccounts.findMany({ where: { companyId, codigo: { in: nuevas.map((n) => n.codigo) } }, select: { codigo: true } })).map((c) => c.codigo));
  const porLongitud = new Map<number, CuentaNuevaPlan[]>();
  for (const n of nuevas) {
    if (yaEstan.has(n.codigo)) continue;
    if (!porLongitud.has(n.codigo.length)) porLongitud.set(n.codigo.length, []);
    porLongitud.get(n.codigo.length)!.push(n);
  }
  let creadas = 0;
  for (const l of [...porLongitud.keys()].sort((a, b) => a - b)) {
    const data = [];
    for (const n of porLongitud.get(l)!) {
      const m = madres.get(n.madre);
      if (!m) continue;
      const fila = {
        id: randomUUID(),
        companyId,
        codigo: n.codigo,
        nombre: n.nombre.slice(0, 190),
        grupo: m.grupo,
        nivel: m.nivel + 1,
        naturaleza: m.naturaleza,
        tipoUso: m.tipoUso,
        esBasePGC: false,
        esPersonalizadaEmpresa: true,
        activo: true,
        parentId: m.id,
        parentCodigo: m.codigo,
        notas: NOTA_PLAN,
      };
      data.push(fila);
      madres.set(fila.codigo, { ...m, ...fila });
    }
    if (data.length) {
      await tx.chartOfAccounts.createMany({ data });
      creadas += data.length;
    }
  }
  return creadas;
}

/** Guarda la longitud en las reglas de la empresa (sin pasar por la comprobacion de Configuracion: la decide el plan). */
async function fijarLongitud(tx: TransaccionBD, companyId: string, longitud: number): Promise<void> {
  const fila = await tx.reglasContables.findUnique({ where: { companyId }, select: { data: true } });
  const data = { ...((fila?.data as object | null) ?? {}), longitudSubcuentas: longitud };
  await tx.reglasContables.upsert({ where: { companyId }, update: { data }, create: { companyId, data } });
}

/** La subcuenta antigua de la ficha (sin movimientos) queda inactiva en el plan, con una nota. */
async function retirarSustituida(tx: TransaccionBD, companyId: string, antigua: string, nueva: string): Promise<void> {
  await tx.chartOfAccounts.updateMany({
    where: { companyId, codigo: antigua },
    data: { activo: false, notas: `Sustituida por la ${nueva} del plan contable anterior. El código no se reutiliza.` },
  });
}

/** Enlaza una subcuenta 430/400/410 a la ficha (y la da de alta en el plan con su nombre fiscal). */
async function enlazarEnTx(tx: TransaccionBD, companyId: string, codigo: string, ficha: { tipo: TipoFicha; id: string }): Promise<{ sustituida: string | null }> {
  const prefijo = codigo.slice(0, 3);
  if (ficha.tipo === 'cliente') {
    const c = await tx.customer.findFirstOrThrow({ where: { id: ficha.id, companyId } });
    const antigua = c.subcuenta430 && c.subcuenta430 !== codigo ? c.subcuenta430 : null;
    await tx.customer.update({ where: { id: c.id }, data: { subcuenta430: codigo } });
    if (antigua) await retirarSustituida(tx, companyId, antigua, codigo);
    await asegurarSubcuentaEnPlan(tx, companyId, codigo, c.nombreFiscal, ficha);
    return { sustituida: antigua };
  }
  const p = await tx.supplier.findFirstOrThrow({ where: { id: ficha.id, companyId } });
  const campo = prefijo === '400' ? 'subcuenta400' : 'subcuenta410';
  const otro = prefijo === '400' ? 'subcuenta410' : 'subcuenta400';
  const antigua = p[campo] && p[campo] !== codigo ? p[campo] : null;
  const data: { subcuenta400?: string | null; subcuenta410?: string | null } = { [campo]: codigo };
  // La gemela automatica (mismo numero viejo y sin movimientos ni alta en el plan) se suelta para que lleve el nuevo numero.
  const gemela = p[otro];
  if (antigua && gemela && gemela.slice(3) === antigua.slice(3)) {
    const usada = (await tx.journalEntryLine.count({ where: { companyId, accountCode: gemela } })) > 0 || (await tx.chartOfAccounts.count({ where: { companyId, codigo: gemela } })) > 0;
    if (!usada) data[otro] = null;
  }
  await tx.supplier.update({ where: { id: p.id }, data });
  if (antigua) await retirarSustituida(tx, companyId, antigua, codigo);
  await asegurarSubcuentaEnPlan(tx, companyId, codigo, p.nombreFiscal, ficha);
  return { sustituida: antigua };
}

export async function confirmarPlan(companyId: string, entrada: EntradaPlan): Promise<ResultadoPlan> {
  await asegurarPlanContableEmpresa(companyId);
  const { cuentas, lectura } = separar(entrada);
  return conReintentoSubcuenta(() =>
    prisma.$transaction(async (tx) => {
      const { vista } = await analizar(tx, companyId, cuentas, entrada.terceros ?? [], lectura, entrada.permisos);
      if (!vista.puedeConfirmar) throw badRequest(vista.errores[0], { errores: vista.errores });

      const cuentasCreadas = await crearCuentas(tx, companyId, vista.cuentasNuevas);
      // Primero la longitud: las fichas nuevas y las gemelas 410N salen con ella.
      let longitudFijada: number | null = null;
      if (vista.longitud.seFija && vista.longitud.delPlan) {
        await fijarLongitud(tx, companyId, vista.longitud.delPlan);
        longitudFijada = vista.longitud.delPlan;
      } else if (vista.longitud.delPlan && vista.longitud.delPlan !== vista.longitud.actual && (await longitudSubcuentasGuardada(companyId, tx)) === null) {
        // El plan trae otra longitud que no se puede usar: se guarda la que ya usaba la
        // empresa, para que las subcuentas traidas no la cambien al deducirla.
        await fijarLongitud(tx, companyId, vista.longitud.actual);
        longitudFijada = vista.longitud.actual;
      }

      let fichasEnlazadas = 0;
      let fichasCreadas = 0;
      const nuevasPorNif = new Map<string, string>();
      const proveedoresTocados = new Set<string>();
      for (const t of vista.terceros) {
        if (t.accion === 'enlazar' && t.ficha?.id) {
          await enlazarEnTx(tx, companyId, t.codigo, { tipo: t.tipo, id: t.ficha.id });
          if (t.tipo === 'proveedor') proveedoresTocados.add(t.ficha.id);
          fichasEnlazadas++;
        } else if (t.accion === 'crear' && t.nif) {
          const clave = `${t.tipo}:${t.nif}`;
          let id = nuevasPorNif.get(clave);
          if (!id) {
            id =
              t.tipo === 'cliente'
                ? (await tx.customer.create({ data: { companyId, nombreFiscal: t.nombre, nifCif: t.nif, pais: paisDelCliente({ pais: 'ES', nifCif: t.nif }) } })).id
                : (await tx.supplier.create({ data: { companyId, nombreFiscal: t.nombre, nifCif: t.nif, pais: paisDelCliente({ pais: 'ES', nifCif: t.nif }) } })).id;
            nuevasPorNif.set(clave, id);
            fichasCreadas++;
          }
          await enlazarEnTx(tx, companyId, t.codigo, { tipo: t.tipo, id });
          if (t.tipo === 'proveedor') proveedoresTocados.add(id);
        }
      }
      // Proveedores con solo una de las dos: la gemela con el mismo numero (si esta libre).
      for (const id of proveedoresTocados) {
        const p = await tx.supplier.findUniqueOrThrow({ where: { id }, select: { id: true, subcuenta400: true, subcuenta410: true } });
        await asignarSubcuentasProveedor(tx, companyId, p);
      }
      return { vista, cuentasCreadas, fichasEnlazadas, fichasCreadas, pendientes: vista.resumen.pendientes, longitudFijada };
    }, OPCIONES_TX),
  );
}

// ---------------------------------------------------------------------------
// Subcuentas sin enlazar y enlace a mano
// ---------------------------------------------------------------------------

export interface SubcuentaSinEnlazar {
  codigo: string;
  nombre: string;
  tipo: TipoFicha;
  activa: boolean;
  apuntes: number;
}

/** Subcuentas 430/400/410 del plan que no son de ninguna ficha (traidas del plan o de un diario importado). */
export async function subcuentasSinEnlazar(companyId: string): Promise<SubcuentaSinEnlazar[]> {
  const [plan, clientes, proveedores] = await Promise.all([
    prisma.chartOfAccounts.findMany({
      where: { companyId, OR: ['430', '400', '410'].map((p) => ({ codigo: { startsWith: p } })) },
      select: { codigo: true, nombre: true, activo: true, parentCodigo: true },
      orderBy: { codigo: 'asc' },
    }),
    prisma.customer.findMany({ where: { companyId, subcuenta430: { not: null } }, select: { subcuenta430: true } }),
    prisma.supplier.findMany({ where: { companyId }, select: { subcuenta400: true, subcuenta410: true } }),
  ]);
  const enlazadas = new Set([...clientes.map((c) => c.subcuenta430), ...proveedores.flatMap((p) => [p.subcuenta400, p.subcuenta410])].filter(Boolean));
  const sueltas = plan.filter(
    (c) => esSubcuentaDeTercero(c.codigo) && !enlazadas.has(c.codigo) && (!c.parentCodigo || MADRES_TERCERO.includes(c.parentCodigo)),
  );
  if (!sueltas.length) return [];
  const apuntes = new Map(
    (await prisma.journalEntryLine.groupBy({ by: ['accountCode'], where: { companyId, accountCode: { in: sueltas.map((s) => s.codigo) } }, _count: { _all: true } })).map((g) => [
      g.accountCode,
      g._count._all,
    ]),
  );
  return sueltas.map((s) => ({ codigo: s.codigo, nombre: s.nombre, tipo: PREFIJO_TIPO[s.codigo.slice(0, 3)], activa: s.activo, apuntes: apuntes.get(s.codigo) ?? 0 }));
}

/**
 * Enlaza a mano una subcuenta suelta del plan a una ficha (que ya existe o que
 * se crea con el nombre y el NIF indicados). Si la ficha ya tiene una subcuenta
 * de ese prefijo con movimientos, 409; si no los tiene, la cambia y la antigua
 * queda inactiva.
 */
export async function enlazarSubcuenta(
  companyId: string,
  datos: { codigo?: unknown; fichaId?: unknown; nueva?: { nombreFiscal?: unknown; nifCif?: unknown } | null },
  permisos: PermisosAlta = TODOS_PERMISOS,
): Promise<{ codigo: string; tipo: TipoFicha; fichaId: string; fichaCreada: boolean; sustituida: string | null }> {
  const codigo = normalizarCuenta(datos.codigo);
  if (!codigo || !esSubcuentaDeTercero(codigo)) throw badRequest('Indica una subcuenta de clientes (430) o de proveedores (400 o 410).', { campo: 'codigo' });
  const tipo = PREFIJO_TIPO[codigo.slice(0, 3)];
  const fichaId = typeof datos.fichaId === 'string' && datos.fichaId.trim() ? datos.fichaId.trim() : null;
  if (!fichaId && !datos.nueva) throw badRequest(`Elige el ${tipo} o escribe los datos del nuevo.`, { campo: 'fichaId' });
  if (!fichaId && !permisos[tipo]) {
    throw forbidden(`${TEXTO_SIN_PERMISO[tipo]}. Enlázala a uno que ya exista o pídeselo al administrador.`, {
      permisos: [tipo === 'cliente' ? 'ventas:write' : 'compras:write'],
    });
  }
  return conReintentoSubcuenta(() =>
    prisma.$transaction(async (tx) => {
      const enPlan = await tx.chartOfAccounts.findFirst({ where: { companyId, codigo } });
      if (!enPlan) throw notFound(`La subcuenta ${codigo} no está en tu plan contable.`);
      const deOtro =
        tipo === 'cliente'
          ? await tx.customer.findFirst({ where: { companyId, subcuenta430: codigo }, select: { id: true, nombreFiscal: true } })
          : await tx.supplier.findFirst({ where: { companyId, OR: [{ subcuenta400: codigo }, { subcuenta410: codigo }] }, select: { id: true, nombreFiscal: true } });
      if (deOtro && deOtro.id !== fichaId) throw conflict(`La subcuenta ${codigo} ya es de ${deOtro.nombreFiscal}.`, { campo: 'codigo', fichaId: deOtro.id });

      let id = fichaId;
      let fichaCreada = false;
      if (!id) {
        const nombreFiscal = typeof datos.nueva?.nombreFiscal === 'string' && datos.nueva.nombreFiscal.trim() ? datos.nueva.nombreFiscal.trim().slice(0, 190) : enPlan.nombre;
        const nif = normalizarNif(datos.nueva?.nifCif);
        if (!nifValido(nif)) throw badRequest('Escribe el NIF del nuevo cliente o proveedor.', { campo: 'nueva.nifCif' });
        const ya =
          tipo === 'cliente'
            ? await tx.customer.findFirst({ where: { companyId, nifCif: nif }, select: { id: true, nombreFiscal: true } })
            : await tx.supplier.findFirst({ where: { companyId, nifCif: nif }, select: { id: true, nombreFiscal: true } });
        if (ya) throw conflict(`Ya existe un ${tipo} con ese NIF: ${ya.nombreFiscal}. Elígelo en vez de crear otro.`, { campo: 'nueva.nifCif', fichaId: ya.id });
        const data = { companyId, nombreFiscal, nifCif: nif, pais: paisDelCliente({ pais: 'ES', nifCif: nif }) };
        id = tipo === 'cliente' ? (await tx.customer.create({ data })).id : (await tx.supplier.create({ data })).id;
        fichaCreada = true;
      } else {
        const ficha =
          tipo === 'cliente'
            ? await tx.customer.findFirst({ where: { id, companyId }, select: { subcuenta430: true, nombreFiscal: true } })
            : await tx.supplier.findFirst({ where: { id, companyId }, select: { subcuenta400: true, subcuenta410: true, nombreFiscal: true } });
        if (!ficha) throw notFound(tipo === 'cliente' ? 'Cliente no encontrado.' : 'Proveedor no encontrado.');
        const f = ficha as { subcuenta430?: string | null; subcuenta400?: string | null; subcuenta410?: string | null; nombreFiscal: string };
        const actual = tipo === 'cliente' ? f.subcuenta430 : codigo.startsWith('400') ? f.subcuenta400 : f.subcuenta410;
        if (actual && actual !== codigo && (await tx.journalEntryLine.count({ where: { companyId, accountCode: actual } })) > 0) {
          throw conflict(`${f.nombreFiscal} ya tiene la subcuenta ${actual} con movimientos: no se puede cambiar por la ${codigo}.`, { campo: 'fichaId', subcuenta: actual });
        }
      }
      const { sustituida } = await enlazarEnTx(tx, companyId, codigo, { tipo, id });
      if (tipo === 'proveedor') {
        const p = await tx.supplier.findUniqueOrThrow({ where: { id }, select: { id: true, subcuenta400: true, subcuenta410: true } });
        await asignarSubcuentasProveedor(tx, companyId, p);
      }
      // Enlazada a una ficha, la subcuenta vuelve a estar activa (con el nombre fiscal, ya puesto al enlazarla).
      await tx.chartOfAccounts.updateMany({ where: { companyId, codigo }, data: { activo: true } });
      return { codigo, tipo, fichaId: id, fichaCreada, sustituida };
    }),
  );
}
