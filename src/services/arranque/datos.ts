/**
 * De los ficheros de la gestoria a los datos de la carga, sin base de datos:
 * se leen todos los libros (lectorLibros), se clasifica cada hoja
 * (clasificador), se aplican las decisiones de la persona (tipo, columnas,
 * hojas que no se usan) y se sacan sus datos (extractores). Las hojas del mismo
 * tipo se juntan cuando tiene sentido (planes, listados, carteras de cobros y
 * de pagos) y chocan cuando no (dos sumas y saldos, dos diarios).
 *
 * Determinista: los mismos ficheros con los mismos ajustes dan los mismos
 * datos (el analisis y cada fase de la importacion lo vuelven a calcular).
 */
import { esSubcuentaDeTercero } from '../terceros/numeracion';
import { longitudDelPlan, nombreComparable } from '../puestaEnMarcha/planAnterior';
import type { CuentaSaldo, LecturaDiario } from '../puestaEnMarcha/lectorContable';
import type { Campo } from './campos';
import { clasificarHoja, NOMBRE_TIPO, TIPOS_HOJA, type Programa, type TipoHoja } from './clasificador';
import { extraerHoja, type ActivoLeido, type ColumnaHoja, type CuentaLeida, type ErrorExtraccion, type PartidaLeida, type TerceroLeido, type TotalesOficiales } from './extractores';
import { leerLibro } from './lectorLibros';

export type TipoCarga = 'PROVISIONAL' | 'DEFINITIVA';

/** Lo que decide la persona sobre una hoja. */
export interface AjusteHoja {
  tipo?: TipoHoja;
  mapeo?: Partial<Record<Campo, number>>;
  /** Fila de titulos (1-based; 0 = sin titulos) del mapeo a mano. */
  filaCabecera?: number;
  excluida?: boolean;
}

export interface AjustesCarga {
  tipoCarga?: TipoCarga;
  /** Por hoja: clave `idHoja` (ver idHoja). */
  hojas?: Record<string, AjusteHoja>;
  /** Resultado de 2026 que da la gestoria, para comprobarlo. */
  resultadoDeclarado?: number | null;
  /** Fecha del sumas y saldos si el fichero no la dice (AAAA-MM-DD). */
  fechaCorte?: string | null;
  /** Por cada 572 de la apertura: saldo del extracto a 31-12 y la cuenta bancaria de Tesoreria. */
  bancos?: Record<string, AjusteBanco>;
  /** Datos fiscales que se arrastran de 2026 (303 del 4T, cuotas a compensar, bases negativas...). */
  datosFiscales?: DatosFiscales;
  /** Motivo del asiento de ajuste de la apertura cuando enero ya esta bloqueado. */
  motivoAjuste?: string | null;
}

/** Saldo del extracto a 31-12 de una 572 y con que cuenta bancaria se enlaza. */
export interface AjusteBanco {
  saldoExtracto: number | null;
  /** Cuenta de Tesoreria que ya existe (con esa misma subcuenta). */
  bankAccountId?: string | null;
  /** Alta de la cuenta en Tesoreria si no existe. */
  nueva?: { iban: string; bancoNombre?: string | null } | null;
  /** La diferencia con la contabilidad son partidas en transito y se acepta. */
  aceptarDiferencia?: boolean;
}

/** Datos fiscales de 2026 escritos a mano en el resumen. */
export interface DatosFiscales {
  /** Resultado del 303 del 4T: positivo, a ingresar; negativo, a devolver o a compensar. */
  resultado303T4?: number | null;
  /** Cuotas de IVA a compensar en 2027 ([110] del 303 del 1T); 0 si se pidio la devolucion. */
  cuotasIvaACompensar?: number | null;
  /** Bases imponibles negativas pendientes (Modelo 200). */
  basesNegativas?: Array<{ ejercicio: number; importe: number }>;
  /** Deducciones pendientes de aplicar (Modelo 200). */
  deducciones?: Array<{ concepto: string; importe: number }>;
}

export interface FicheroLeible {
  nombre: string;
  sha256: string;
  contenido: Buffer;
}

/** Hoja tal como se ensena en el resumen. */
export interface HojaAnalizada {
  id: string;
  fichero: string;
  sha256: string;
  hoja: string;
  formato: string;
  /** El tipo con el que se usa (el reconocido o el que eligio la persona). */
  tipo: TipoHoja;
  nombreTipo: string;
  tipoReconocido: TipoHoja;
  elegidoAMano: boolean;
  confianza: number;
  candidatos: Array<{ tipo: TipoHoja; nombre: string; puntos: number }>;
  dudosa: boolean;
  programa: Programa;
  textoPrograma: string | null;
  fechaCorte: string | null;
  filas: number;
  excluida: boolean;
  /** Columnas usadas (indice de cada dato). */
  mapeo: Partial<Record<Campo, number>>;
  /** «1.234 cuentas, 312 con NIF». */
  resumen: string;
  avisos: string[];
  /** Columnas leidas y su fila de titulos (1-based; 0 = sin titulos), para revisarlas a mano. */
  columnas?: ColumnaHoja[];
  filaTitulos?: number;
  /** Si no se ha podido leer: por que y, si hace falta, las columnas para elegir. */
  error: (Partial<ErrorExtraccion> & { mensaje: string }) | null;
}

export interface DatosCarga {
  hojas: HojaAnalizada[];
  /** Ficheros repetidos (misma huella) que no se vuelven a leer. */
  repetidos: string[];
  presentes: Set<TipoHoja>;
  hojasConError: Array<{ fichero: string; hoja: string; mensaje: string }>;
  /** Tipos con dos hojas distintas que no se pueden juntar. */
  choques: Array<{ tipo: TipoHoja; hojas: string[] }>;
  /** Longitud de las subcuentas del plan (para expandir «430.1» y para comprobar). */
  longitud: number | null;
  plan: CuentaLeida[] | null;
  terceros: TerceroLeido[];
  sumasSaldos: { cuentas: CuentaSaldo[]; fechaCorte: string | null; hoja: string } | null;
  pyg: TotalesOficiales | null;
  balance: TotalesOficiales | null;
  diario: { lectura: LecturaDiario; hoja: string } | null;
  cartera: PartidaLeida[] | null;
  inmovilizado: ActivoLeido[] | null;
}

export const idHoja = (sha256: string, hoja: string) => `${sha256.slice(0, 12)}:${hoja}`;

/** «1.234»: punto de miles tambien con cuatro cifras. */
export const miles = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
const varios = (n: number, uno: string, muchos: string) => `${miles(n)} ${n === 1 ? uno : muchos}`;

/** Tipos que se pueden juntar si vienen en varias hojas. */
const SE_JUNTAN: ReadonlySet<TipoHoja> = new Set(['PLAN', 'TERCEROS_CLIENTES', 'TERCEROS_PROVEEDORES', 'CARTERA', 'INMOVILIZADO']);

function resumenHoja(tipo: TipoHoja, e: ReturnType<typeof extraerHoja>['extraccion']): string {
  if (!e) return '';
  switch (e.tipo) {
    case 'PLAN':
      return `${varios(e.cuentas.length, 'cuenta', 'cuentas')}, ${miles(e.cuentas.filter((c) => c.nif).length)} con NIF`;
    case 'TERCEROS_CLIENTES':
    case 'TERCEROS_PROVEEDORES':
      return `${varios(e.terceros.length, tipo === 'TERCEROS_CLIENTES' ? 'cliente' : 'proveedor o acreedor', tipo === 'TERCEROS_CLIENTES' ? 'clientes' : 'proveedores y acreedores')}, ${miles(e.terceros.filter((t) => t.nif).length)} con NIF`;
    case 'SUMAS_Y_SALDOS':
      return `${varios(e.lectura.cuentas.length, 'subcuenta', 'subcuentas')}, ${miles(e.lectura.cuentas.filter((c) => Math.round(c.saldo * 100) !== 0).length)} con saldo`;
    case 'DIARIO': {
      const fechas = e.lectura.apuntes.map((a) => a.fecha).sort();
      const es = (f?: string) => (f ? f.split('-').reverse().join('/') : '');
      return `${varios(e.lectura.apuntes.length, 'apunte', 'apuntes')}, del ${es(fechas[0])} al ${es(fechas[fechas.length - 1])}`;
    }
    case 'CARTERA':
      return `${varios(e.partidas.length, 'factura pendiente', 'facturas pendientes')}`;
    case 'INMOVILIZADO':
      return `${varios(e.activos.length, 'bien', 'bienes')}`;
    case 'PYG':
      return e.totales.resultado !== null ? 'Con el resultado del ejercicio' : 'Sin la línea del resultado del ejercicio';
    case 'BALANCE':
      return 'Balance oficial (solo para comparar)';
  }
}

/** Lee, clasifica y extrae todos los ficheros de la carga. */
export function prepararDatos(ficheros: FicheroLeible[], ajustes: AjustesCarga = {}): DatosCarga {
  const datos: DatosCarga = {
    hojas: [],
    repetidos: [],
    presentes: new Set(),
    hojasConError: [],
    choques: [],
    longitud: null,
    plan: null,
    terceros: [],
    sumasSaldos: null,
    pyg: null,
    balance: null,
    diario: null,
    cartera: null,
    inmovilizado: null,
  };

  // 1. Leer y clasificar todas las hojas (un fichero repetido se lee una vez).
  interface Pendiente {
    h: HojaAnalizada;
    filas: unknown[][];
    cabecera: ReturnType<typeof clasificarHoja>['cabecera'];
    ajuste: AjusteHoja;
  }
  const pendientes: Pendiente[] = [];
  const vistos = new Set<string>();
  for (const f of ficheros) {
    if (vistos.has(f.sha256)) {
      datos.repetidos.push(f.nombre);
      continue;
    }
    vistos.add(f.sha256);
    const libro = leerLibro(f.contenido, f.nombre);
    if (libro.error) {
      const h: HojaAnalizada = {
        id: idHoja(f.sha256, f.nombre),
        fichero: f.nombre,
        sha256: f.sha256,
        hoja: f.nombre,
        formato: libro.formato,
        tipo: 'DESCONOCIDO',
        nombreTipo: NOMBRE_TIPO.DESCONOCIDO,
        tipoReconocido: 'DESCONOCIDO',
        elegidoAMano: false,
        confianza: 0,
        candidatos: [],
        dudosa: false,
        programa: 'generico',
        textoPrograma: null,
        fechaCorte: null,
        filas: 0,
        excluida: !!ajustes.hojas?.[idHoja(f.sha256, f.nombre)]?.excluida,
        mapeo: {},
        resumen: '',
        // Un fichero que no se puede leer no lleva avisos de lectura (tildes...): solo el error.
        avisos: [],
        error: { mensaje: libro.error.mensaje },
      };
      datos.hojas.push(h);
      if (!h.excluida) datos.hojasConError.push({ fichero: f.nombre, hoja: f.nombre, mensaje: libro.error.mensaje });
      continue;
    }
    for (const hoja of libro.hojas) {
      const id = idHoja(f.sha256, hoja.hoja);
      const ajuste = ajustes.hojas?.[id] ?? {};
      const c = clasificarHoja({ fichero: f.nombre, hoja: hoja.hoja, filas: hoja.filas, formato: libro.formato });
      const elegido = ajuste.tipo && (TIPOS_HOJA as readonly string[]).includes(ajuste.tipo) ? ajuste.tipo : null;
      const tipo = elegido ?? c.tipo;
      const h: HojaAnalizada = {
        id,
        fichero: f.nombre,
        sha256: f.sha256,
        hoja: hoja.hoja,
        formato: libro.formato,
        tipo,
        nombreTipo: NOMBRE_TIPO[tipo],
        tipoReconocido: c.tipo,
        elegidoAMano: !!elegido,
        confianza: c.confianza,
        candidatos: c.candidatos.map((x) => ({ tipo: x.tipo, nombre: NOMBRE_TIPO[x.tipo], puntos: x.puntos })),
        dudosa: !elegido && c.dudosa,
        programa: c.programa,
        textoPrograma: c.textoPrograma,
        fechaCorte: c.fechaCorte,
        filas: c.filasDatos,
        excluida: !!ajuste.excluida,
        mapeo: {},
        resumen: '',
        avisos: [...libro.avisos, ...hoja.avisos],
        error: null,
      };
      datos.hojas.push(h);
      pendientes.push({ h, filas: hoja.filas, cabecera: c.cabecera, ajuste });
    }
  }

  // 2. Primero los planes: su longitud sirve para expandir «430.1» en los demas.
  const orden = (t: TipoHoja) => (t === 'PLAN' ? 0 : 1);
  pendientes.sort((a, b) => orden(a.h.tipo) - orden(b.h.tipo));
  const porTipo = new Map<TipoHoja, string[]>();
  const hojasPorTipo = new Map<TipoHoja, HojaAnalizada[]>();
  const planes: CuentaLeida[][] = [];
  const carteras: PartidaLeida[][] = [];
  const activos: ActivoLeido[][] = [];
  let longitudCalculada = false;

  for (const p of pendientes) {
    const { h } = p;
    if (h.excluida) continue;
    if (h.tipo !== 'PLAN' && !longitudCalculada) {
      longitudCalculada = true;
      const codigos = planes.flat().map((c) => c.codigo);
      datos.longitud = codigos.length ? longitudDelPlan(codigos.filter((c) => c.length > 3), esSubcuentaDeTercero) : null;
    }
    const r = extraerHoja(h.tipo, p.filas, {
      cabecera: p.cabecera,
      mapeo: p.ajuste.mapeo ?? null,
      filaCabecera: p.ajuste.filaCabecera,
      longitud: datos.longitud,
      formato: h.formato,
    });
    h.mapeo = r.mapeo;
    h.avisos.push(...r.avisos);
    if (r.error || !r.extraccion) {
      h.error = r.error ?? { mensaje: 'No se ha podido leer la hoja.' };
      datos.hojasConError.push({ fichero: h.fichero, hoja: h.hoja, mensaje: h.error.mensaje });
      continue;
    }
    h.resumen = resumenHoja(h.tipo, r.extraccion);
    if (r.columnas) h.columnas = r.columnas;
    if (r.filaTitulos !== undefined) h.filaTitulos = r.filaTitulos;
    const e = r.extraccion;
    datos.presentes.add(e.tipo);
    porTipo.set(e.tipo, [...(porTipo.get(e.tipo) ?? []), `${h.fichero}${h.hoja !== h.fichero ? ` › ${h.hoja}` : ''}`]);
    hojasPorTipo.set(e.tipo, [...(hojasPorTipo.get(e.tipo) ?? []), h]);
    const choca = !SE_JUNTAN.has(e.tipo) && (porTipo.get(e.tipo)?.length ?? 0) > 1;
    if (choca) continue;
    switch (e.tipo) {
      case 'PLAN':
        planes.push(e.cuentas);
        break;
      case 'TERCEROS_CLIENTES':
      case 'TERCEROS_PROVEEDORES':
        datos.terceros.push(...e.terceros);
        break;
      case 'SUMAS_Y_SALDOS':
        datos.sumasSaldos = { cuentas: e.lectura.cuentas, fechaCorte: ajustes.fechaCorte || h.fechaCorte, hoja: h.id };
        break;
      case 'DIARIO':
        datos.diario = { lectura: e.lectura, hoja: h.id };
        break;
      case 'CARTERA':
        carteras.push(e.partidas);
        break;
      case 'INMOVILIZADO':
        activos.push(e.activos);
        break;
      case 'PYG':
        datos.pyg = e.totales;
        break;
      case 'BALANCE':
        datos.balance = e.totales;
        break;
    }
  }
  if (!longitudCalculada) {
    const codigos = planes.flat().map((c) => c.codigo);
    datos.longitud = codigos.length ? longitudDelPlan(codigos.filter((c) => c.length > 3), esSubcuentaDeTercero) : null;
  }
  for (const [tipo, hojas] of porTipo) {
    if (SE_JUNTAN.has(tipo) || hojas.length < 2) continue;
    datos.choques.push({ tipo, hojas });
    // Cada tarjeta lo dice, para que se vea cuales son sin abrir el detalle.
    const nombre = NOMBRE_TIPO[tipo].toLowerCase();
    for (const h of hojasPorTipo.get(tipo) ?? []) {
      const otras = hojas.filter((x) => x !== `${h.fichero}${h.hoja !== h.fichero ? ` › ${h.hoja}` : ''}`);
      h.avisos.push(`Hay otro fichero de ${nombre} (${otras.join(', ')}): usa solo uno. Marca el que no vale con «No usar esta hoja».`);
    }
  }

  // 3. Juntar lo que viene en varias hojas.
  if (planes.length) {
    const m = new Map<string, CuentaLeida>();
    for (const c of planes.flat()) {
      const previa = m.get(c.codigo);
      if (!previa) m.set(c.codigo, c);
      else m.set(c.codigo, { ...previa, nombre: previa.nombre || c.nombre, nif: previa.nif || c.nif, ficha: previa.ficha ?? c.ficha });
    }
    datos.plan = [...m.values()].sort((a, b) => a.codigo.localeCompare(b.codigo));
  }
  if (carteras.length) datos.cartera = carteras.flat();
  if (activos.length) datos.inmovilizado = activos.flat();
  datos.terceros = juntarTerceros(datos.terceros, datos.plan);
  return datos;
}

/**
 * Listados de clientes y proveedores juntos, sin repetir. A las filas sin
 * subcuenta se les busca la del plan con el mismo nombre (si solo hay una).
 */
function juntarTerceros(terceros: TerceroLeido[], plan: CuentaLeida[] | null): TerceroLeido[] {
  const porNombre = new Map<string, string[]>();
  for (const c of plan ?? []) {
    if (!esSubcuentaDeTercero(c.codigo)) continue;
    const k = nombreComparable(c.nombre);
    if (k) porNombre.set(k, [...(porNombre.get(k) ?? []), c.codigo]);
  }
  const out = new Map<string, TerceroLeido>();
  for (const t of terceros) {
    let subcuenta = t.subcuenta;
    if (!subcuenta && t.nombre) {
      const candidatas = (porNombre.get(nombreComparable(t.nombre)) ?? []).filter((c) => (t.tipo === 'cliente' ? c.startsWith('430') : /^4[01]0/.test(c)));
      if (candidatas.length === 1) subcuenta = candidatas[0];
    }
    const clave = subcuenta ?? `${t.tipo}:${t.nif}`;
    const previo = out.get(clave);
    out.set(clave, previo ? { ...previo, nif: previo.nif || t.nif, nombre: previo.nombre || t.nombre, ficha: { ...t.ficha, ...previo.ficha } } : { ...t, ...(subcuenta ? { subcuenta } : {}) });
  }
  return [...out.values()];
}
