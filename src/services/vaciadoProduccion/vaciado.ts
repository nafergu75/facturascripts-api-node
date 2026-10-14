/**
 * Vaciado de produccion («todo a cero»): simulacion, borrado y comprobacion
 * final. Lo usa scripts/vaciar-produccion.ts, que lanza el usuario con
 * scripts/vaciar-produccion.sh. Ver docs/vaciar-produccion.md.
 *
 * Se borran TODAS las empresas con todos sus datos y todos los usuarios que no
 * son administradores globales. Al administrador se le quitan los vinculos con
 * las empresas. Que pasa con cada tabla: tablas.ts.
 */
import { randomUUID } from 'crypto';
import type { PrismaClient } from '@prisma/client';
import { condicionBorrado, id, MARCAS_AUDITORIA, ordenDeBorrado, TEXTO_DESTINO, type Clasificacion, type Tabla } from './tablas';
import { comprobarEsquema, contar, contarPorEmpresa, esquemaCorrecto, motivosEsquema, num, plural, type EstadoBase } from './bd';
import { carpetaDe, contarReferencias, empresaDeClave, esDeLaApp, type Almacen, type Objeto, type ReferenciasBd } from './almacen';
import { huella, type Manifiesto } from './copia';

/** Lotes de borrado: cada DELETE es su propia transaccion, pequena (TiDB limita su tamano). */
export const LOTE_BORRADO = 500;
/** Lotes en tablas con columnas binarias (logos). */
export const LOTE_BORRADO_BINARIO = 50;

/** Ultima linea de una parada por el esquema. */
export const PARADA_ESQUEMA =
  'La base no es la esperada: es otra base, o tiene una versión del esquema distinta de la de esta carpeta del código. No se sigue. ' +
  'Si acabas de cambiar de rama en esta carpeta, ejecuta npx prisma generate y repite.';

/** Marcas que el vaciado y la restauracion dejan en AuditLog. */
export const [ACCION_VACIADO, ACCION_RESTAURADO] = MARCAS_AUDITORIA;

export interface Contexto {
  db: PrismaClient;
  clasificacion: Clasificacion;
  almacen: Almacen;
}

export interface Usuario {
  id: string;
  email: string;
  activo: boolean;
  adminGlobal: boolean;
  empresas: number;
  passwordHash: string;
}

export interface Empresa {
  id: string;
  nombre: string;
  codigo: string | null;
  denominacion: string | null;
  nif: string | null;
}

export interface FilaTabla {
  tabla: Tabla;
  total: number;
  porEmpresa: Map<string | null, number>;
  aBorrar: number;
  aConservar: number;
}

export interface Simulacion {
  estado: EstadoBase;
  /** Si hay alguna, no se borra nada. */
  paradas: string[];
  avisos: string[];
  usuarios: Usuario[];
  /** Administradores globales que se conservan. */
  conservados: Usuario[];
  empresas: Empresa[];
  filas: FilaTabla[];
  /** null: sin acceso al almacen. */
  objetos: { deLaApp: Objeto[]; ajenos: Objeto[] } | null;
  referencias: ReferenciasBd | null;
  ajustesPlataforma: Array<{ clave: string; valor: string }>;
}

export async function leerUsuarios(db: PrismaClient): Promise<Usuario[]> {
  const filas = await db.$queryRawUnsafe<Array<{ id: string; email: string; activo: unknown; admin: unknown; empresas: unknown; passwordHash: string }>>(
    `SELECT u.${id('id')} AS id, u.${id('email')} AS email, u.${id('isActive')} AS activo, u.${id('isGlobalAdmin')} AS admin, u.${id('passwordHash')} AS passwordHash,
       (SELECT COUNT(*) FROM ${id('Membership')} m WHERE m.${id('userId')} = u.${id('id')}) AS empresas
     FROM ${id('User')} u ORDER BY u.${id('isGlobalAdmin')} DESC, u.${id('email')} ASC`,
  );
  const si = (v: unknown) => v === true || num(v) === 1;
  return filas.map((f) => ({ id: f.id, email: f.email, activo: si(f.activo), adminGlobal: si(f.admin), empresas: num(f.empresas), passwordHash: f.passwordHash }));
}

export async function leerEmpresas(db: PrismaClient): Promise<Empresa[]> {
  const filas = await db.$queryRawUnsafe<Array<{ id: string; nombre: string; codigo: string | null; denominacion: string | null; nif: string | null }>>(
    `SELECT c.${id('id')} AS id, c.${id('name')} AS nombre, c.${id('codigo')} AS codigo, l.${id('denominacion')} AS denominacion, l.${id('nif')} AS nif
     FROM ${id('Company')} c LEFT JOIN ${id('LegalConfig')} l ON l.${id('companyId')} = c.${id('id')} ORDER BY c.${id('createdAt')} ASC`,
  );
  return filas;
}

/**
 * Lo que haria el vaciado, sin escribir nada. `conservar`: ids de los
 * administradores globales que se conservan (por defecto, todos).
 */
export async function simular(ctx: Contexto, conservar?: readonly string[]): Promise<Simulacion> {
  const { db, clasificacion, almacen } = ctx;
  const tablas = clasificacion.tablas;
  const paradas: string[] = [];
  const avisos: string[] = [];

  if (clasificacion.sinClasificar.length) {
    paradas.push(
      `Hay tablas en el esquema que no son de ninguna empresa y el script no sabe si borrar o conservar: ${clasificacion.sinClasificar.join(', ')}. Hay que decidirlo en src/services/vaciadoProduccion/tablas.ts (REGLAS).`,
    );
  }
  const estado = await comprobarEsquema(db, tablas);
  if (!esquemaCorrecto(estado)) {
    paradas.push(...motivosEsquema(estado));
    paradas.push(PARADA_ESQUEMA);
    // Sin el esquema esperado, las consultas siguientes pueden fallar: se para aqui.
    return { estado, paradas, avisos, usuarios: [], conservados: [], empresas: [], filas: [], objetos: null, referencias: null, ajustesPlataforma: [] };
  }
  if (!estado.esTidb) avisos.push(`La base no es TiDB (${estado.version}). Producción está en TiDB Cloud: comprueba que ENV_PROD apunta a la de producción.`);

  const usuarios = await leerUsuarios(db);
  const admins = usuarios.filter((u) => u.adminGlobal);
  let conservados = admins;
  if (conservar) {
    const pedidos = new Set(conservar);
    const noAdmins = [...pedidos].filter((x) => !admins.some((a) => a.id === x));
    if (noAdmins.length) paradas.push('Alguno de los usuarios elegidos para conservar no es administrador global.');
    conservados = admins.filter((a) => pedidos.has(a.id));
  }
  if (!conservados.some((a) => a.activo)) {
    paradas.push('No queda ningún administrador global ACTIVO que conservar: nadie podría entrar después. Nombra uno con scripts/hacer-admin-global.sh.');
  }

  // VERI*FACTU: un registro ya enviado a la AEAT no se borra.
  paradas.push(...(await comprobarVerifactu(db, tablas)));

  const empresas = await leerEmpresas(db);
  const idsConservados = conservados.map((a) => a.id);
  const filas: FilaTabla[] = [];
  for (const t of tablas) {
    const porEmpresa = await contarPorEmpresa(db, t);
    const total = [...porEmpresa.values()].reduce((s, n) => s + n, 0);
    let aBorrar = 0;
    if (t.destino === 'VACIAR') aBorrar = total;
    else if (t.destino === 'PARCIAL' && total) aBorrar = idsConservados.length ? await contar(db, t.nombre, condicionBorrado(t, idsConservados)!) : total;
    filas.push({ tabla: t, total, porEmpresa, aBorrar, aConservar: total - aBorrar });
  }

  const presentadas = await contarSiExiste(db, tablas, 'DeclaracionAeat', `${id('estado')} = 'presentada'`);
  if (presentadas) {
    avisos.push(`${presentadas === 1 ? 'Hay 1 declaración marcada como presentada' : `Hay ${fmt(presentadas)} declaraciones marcadas como presentadas`} a la AEAT. Si alguna es real y no de prueba, guarda su justificante antes: se borran.`);
  }

  let objetos: Simulacion['objetos'] = null;
  if (almacen.tipo !== 'ninguno') {
    const todos = await almacen.listar();
    objetos = { deLaApp: todos.filter((x) => esDeLaApp(x.clave)), ajenos: todos.filter((x) => !esDeLaApp(x.clave)) };
    if (objetos.ajenos.length) avisos.push(`En el almacén hay ${plural(objetos.ajenos.length, 'fichero', 'ficheros')} fuera de las carpetas de la app: no se tocan.`);
  } else {
    avisos.push(`No se pueden ver ni borrar los ficheros guardados: ${almacen.descripcion}`);
  }
  const referencias = await contarReferencias(db, tablas);

  const ajustesPlataforma = tablas.some((t) => t.nombre === 'AjustePlataforma')
    ? await db.$queryRawUnsafe<Array<{ clave: string; valor: string }>>(`SELECT ${id('clave')} AS clave, CAST(${id('valor')} AS CHAR) AS valor FROM ${id('AjustePlataforma')} ORDER BY ${id('clave')}`)
    : [];
  const red = ajustesPlataforma.find((a) => a.clave === 'verifactu.redSeguridad');
  if (red && /"activa"\s*:\s*false/.test(red.valor)) {
    avisos.push('La red de seguridad de VERI*FACTU está DESACTIVADA en la plataforma y se conserva así. Si fue para probar, vuelve a activarla en Administración.');
  }

  return { estado, paradas, avisos, usuarios, conservados, empresas, filas, objetos, referencias, ajustesPlataforma };
}

async function contarSiExiste(db: PrismaClient, tablas: readonly Tabla[], tabla: string, where: string): Promise<number> {
  if (!tablas.some((t) => t.nombre === tabla)) return 0;
  const [f] = await db.$queryRawUnsafe<Array<{ n: unknown }>>(`SELECT COUNT(*) AS n FROM ${id(tabla)} WHERE ${where}`);
  return num(f?.n);
}

/**
 * Hoy (F1) la app no envia nada a la AEAT: las facturas que se emiten con
 * VERI*FACTU en PRUEBAS llevan su registro encadenado (VerifactuRegistro, con
 * su cadena en VerifactuCadena), pero el envio llega en la fase F3. Esos
 * registros son inalterables para la app (config/inmutabilidadVerifactu.ts):
 * aqui se borran con SQL, como todo lo demas (vaciar()), sin pasar por esa
 * extension. Si hay registros de la AEAT de verdad o una empresa con
 * VERI*FACTU activo o en el entorno de produccion, el script se para en vez
 * de borrarlos.
 *
 * Lo del entorno de PRUEBAS de la AEAT no tiene efecto fiscal y se borra como
 * el resto: en una tabla de VERI*FACTU con columna `entorno` solo paran las
 * filas de PRODUCCION. Sin esa columna, para si parece de registros (huella,
 * estado de envio o CSV) y tiene filas; si no (certificados, bitacora), no.
 */
export async function comprobarVerifactu(db: Pick<PrismaClient, '$queryRawUnsafe'>, tablas: readonly Pick<Tabla, 'nombre' | 'columnas'>[]): Promise<string[]> {
  const paradas: string[] = [];
  if (tablas.some((t) => t.nombre === 'VerifactuConfig')) {
    const [f] = await db.$queryRawUnsafe<Array<{ n: unknown }>>(
      `SELECT COUNT(*) AS n FROM ${id('VerifactuConfig')} WHERE ${id('estado')} = 'ACTIVO' OR ${id('entorno')} = 'PRODUCCION'`,
    );
    if (num(f?.n)) {
      paradas.push(
        `${num(f?.n) === 1 ? 'Hay 1 empresa' : `Hay ${num(f?.n)} empresas`} con VERI*FACTU activo o apuntando a la AEAT de verdad (entorno de producción). Sus registros pueden estar ya enviados a Hacienda y no se borran con este script: consúltalo con la gestoría.`,
      );
    }
  }
  for (const t of tablas) {
    if (t.nombre === 'VerifactuConfig' || !/verifactu|registrofactur|envioaeat/i.test(t.nombre)) continue;
    const tiene = (c: string) => t.columnas.some((x) => x.nombre === c);
    let n = 0;
    if (tiene('entorno')) n = await contar(db, t.nombre, { sql: `${id('entorno')} = 'PRODUCCION'`, params: [] });
    else if (tiene('huella') || tiene('estadoEnvio') || tiene('csv')) n = await contar(db, t.nombre);
    if (n) {
      paradas.push(
        `La tabla ${t.nombre} tiene ${plural(n, 'registro', 'registros')} de VERI*FACTU de la AEAT de verdad (entorno de producción). Pueden estar enviados a Hacienda: no se borran con este script.`,
      );
    }
  }
  return paradas;
}

// ---------------- Informe de la simulacion ----------------

const fmt = (n: number) => n.toLocaleString('es-ES');
export function tamano(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1).replace('.', ',')} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
}
const punteada = (izq: string, der: string, ancho = 46) => `${izq} ${'.'.repeat(Math.max(2, ancho - izq.length - der.length))} ${der}`;

/** Texto de la simulacion, linea a linea. */
export function informeSimulacion(s: Simulacion, almacen: Almacen): string[] {
  const l: string[] = [];
  const raya = '='.repeat(64);
  l.push(raya, 'VACIAR PRODUCCIÓN · SIMULACIÓN (no se borra nada)', raya);
  l.push(`Base de datos: ${s.estado.base || '(sin nombre)'} · ${s.estado.esTidb ? 'TiDB' : 'no es TiDB'} (${s.estado.version})`);
  l.push(
    esquemaCorrecto(s.estado)
      ? `Esquema: el de esta versión (${s.filas.length || s.estado.tablasEnBase} tablas con todas sus columnas)${s.estado.conMigraciones ? '' : '; sin _prisma_migrations, como siempre en producción (se creó con db push)'}.`
      : 'Esquema: NO es el de esta versión.',
  );
  l.push(`Ficheros: ${almacen.descripcion}`);

  if (s.usuarios.length) {
    l.push('', `USUARIOS (${s.usuarios.length})`);
    const conservados = new Set(s.conservados.map((u) => u.id));
    for (const u of s.usuarios) {
      const queda = conservados.has(u.id);
      const datos = [u.adminGlobal ? 'administrador global' : 'usuario', u.activo ? 'activo' : 'DESACTIVADO'];
      if (u.empresas) datos.push(queda ? `se le quitan ${u.empresas} empresa${u.empresas === 1 ? '' : 's'}` : `${u.empresas} empresa${u.empresas === 1 ? '' : 's'}`);
      l.push(`  ${queda ? 'SE CONSERVA' : 'SE BORRA   '}  ${u.email} · ${datos.join(', ')}`);
    }
  }

  if (s.filas.length) {
    const nombres = new Map(s.empresas.map((e) => [e.id, e]));
    const HUERFANAS = '(sin empresa)';
    const porEmpresa = new Map<string, Array<[string, number]>>();
    for (const f of s.filas) {
      // Las que no se reparten por empresa (usuarios, contadores...) salen en su apartado.
      if (f.tabla.destino === 'CONSERVAR' || (!f.tabla.columnaEmpresa && !f.tabla.empresaPor)) continue;
      for (const [e, n] of f.porEmpresa) {
        // Filas comunes de una tabla que se vacia en parte (plan base, ajustes de la plataforma): ver su apartado.
        if (e === null && f.tabla.destino === 'PARCIAL') continue;
        const clave = e && nombres.has(e) ? e : HUERFANAS;
        if (!porEmpresa.has(clave)) porEmpresa.set(clave, []);
        const grupo = porEmpresa.get(clave)!;
        // Varias empresas que ya no existen van al mismo grupo: se suman por tabla.
        if (grupo.length && grupo[grupo.length - 1][0] === f.tabla.nombre) grupo[grupo.length - 1][1] += n;
        else grupo.push([f.tabla.nombre, n]);
      }
    }
    l.push('', s.empresas.length ? `EMPRESAS (${s.empresas.length}) · se borran todas, con todos sus datos` : 'EMPRESAS: no hay ninguna');
    s.empresas.forEach((e, i) => {
      const tablas = porEmpresa.get(e.id) ?? [];
      const total = tablas.reduce((a, [, n]) => a + n, 0);
      const nombre = e.denominacion && e.denominacion !== e.nombre ? `${e.nombre} (${e.denominacion})` : e.nombre;
      l.push(`  ${i + 1}. ${nombre}${e.nif ? ` · NIF ${e.nif}` : ''}${e.codigo ? ` · código ${e.codigo}` : ''} · id ${e.id} · ${plural(total, 'fila', 'filas')}`);
      if (tablas.length) l.push(...envolver(tablas.map(([t, n]) => `${t} ${fmt(n)}`), '       '));
    });
    const huerfanas = porEmpresa.get(HUERFANAS);
    if (huerfanas?.length) {
      const total = huerfanas.reduce((a, [, n]) => a + n, 0);
      l.push(`  Filas sin empresa, o de empresas que ya no existen: ${fmt(total)} (también se borran)`);
      l.push(...envolver(huerfanas.map(([t, n]) => `${t} ${fmt(n)}`), '       '));
    }

    l.push('', 'TABLAS QUE SE VACÍAN (filas que se borran)');
    const vaciar = s.filas.filter((f) => f.tabla.destino === 'VACIAR');
    for (const f of vaciar.filter((x) => x.total)) l.push(`  ${punteada(f.tabla.nombre, fmt(f.total))}`);
    const vacias = vaciar.filter((x) => !x.total).map((x) => x.tabla.nombre);
    if (vacias.length) {
      l.push(`  Ya vacías (${vacias.length}):`);
      l.push(...envolver(vacias, '    '));
    }

    l.push('', 'TABLAS QUE SE VACÍAN EN PARTE');
    for (const f of s.filas.filter((x) => x.tabla.destino === 'PARCIAL')) {
      l.push(`  ${f.tabla.nombre} · se borran: ${fmt(f.aBorrar)} · se quedan: ${fmt(f.aConservar)}`);
      l.push(...envolver(f.tabla.motivo.split(' '), '    ', ' '));
    }

    l.push('', 'TABLAS QUE SE CONSERVAN ENTERAS');
    for (const f of s.filas.filter((x) => x.tabla.destino === 'CONSERVAR')) {
      l.push(`  ${f.tabla.nombre} · filas: ${fmt(f.total)}`);
      l.push(...envolver(f.tabla.motivo.split(' '), '    ', ' '));
      if (f.tabla.nombre === 'AjustePlataforma') {
        for (const a of s.ajustesPlataforma) l.push(`    ${a.clave} = ${a.valor.length > 120 ? `${a.valor.slice(0, 117)}...` : a.valor}`);
      }
    }
  }

  // Con una parada antes de mirar nada (esquema distinto) no hay ficheros que ensenar.
  if (s.filas.length) {
    l.push('', `FICHEROS GUARDADOS (${almacen.tipo === 'blob' ? 'Vercel Blob' : almacen.tipo === 'disco' ? 'disco' : 'sin acceso'})`);
    if (s.objetos) {
      const grupos = new Map<string, { n: number; b: number }>();
      for (const o of s.objetos.deLaApp) {
        const g = grupos.get(carpetaDe(o.clave)) ?? { n: 0, b: 0 };
        g.n++;
        g.b += o.tamano;
        grupos.set(carpetaDe(o.clave), g);
      }
      for (const [c, g] of [...grupos.entries()].sort()) l.push(`  ${punteada(c, `${plural(g.n, 'fichero', 'ficheros')} · ${tamano(g.b)}`)}`);
      const total = s.objetos.deLaApp.reduce((a, o) => a + o.tamano, 0);
      l.push(`  Se borrarían: ${plural(s.objetos.deLaApp.length, 'fichero', 'ficheros')} (${tamano(total)}).`);
      if (s.objetos.deLaApp.length) {
        const ids = new Set(s.empresas.map((e) => e.id));
        const porEmp = new Map<string, number>();
        for (const o of s.objetos.deLaApp) {
          const e = empresaDeClave(o.clave, ids);
          const nombre = e ? s.empresas.find((x) => x.id === e)!.nombre : 'sin empresa en la ruta';
          porEmp.set(nombre, (porEmp.get(nombre) ?? 0) + 1);
        }
        l.push(...envolver([...porEmp.entries()].map(([n, c]) => `${n} ${fmt(c)}`), '    ').map((x, i) => (i === 0 ? `  Por empresa: ${x.trim()}` : x)));
      }
      l.push(`  Fuera de las carpetas de la app (no se tocan): ${fmt(s.objetos.ajenos.length)}`);
      for (const o of s.objetos.ajenos.slice(0, 10)) l.push(`    ${o.clave}`);
      if (s.objetos.ajenos.length > 10) l.push(`    … y ${fmt(s.objetos.ajenos.length - 10)} más`);
    } else {
      l.push('  No se pueden ver, así que no se borrarían (ver AVISOS).');
    }
    if (s.referencias) {
      const r = s.referencias;
      const partes = r.porTipo.map((x) => `${x.que} ${fmt(x.n)}`);
      if (r.ficherosCarga) partes.push(`ficheros de la gestoría en las cargas de 2026 ${fmt(r.ficherosCarga)}`);
      l.push('  La base apunta a:');
      l.push(...envolver(partes.length ? partes : ['ningún fichero'], '    '));
      l.push(`  Logos de empresa: ${fmt(r.logos)} (van dentro de la base y se borran con ella).`);
      if (r.imagenesPlantilla) l.push(`  Logos de marca y sellos de la plantilla B: ${fmt(r.imagenesPlantilla)} (también dentro de la base; se borran con ella).`);
    }
  }

  if (s.avisos.length) {
    l.push('', 'AVISOS');
    for (const a of s.avisos) l.push(...parrafo(a));
  }
  if (s.paradas.length) {
    l.push('', 'NO SE PUEDE SEGUIR');
    for (const p of s.paradas) l.push(...parrafo(p));
  }

  if (s.filas.length) {
    const borrar = s.filas.reduce((a, f) => a + f.aBorrar, 0);
    const conservar = s.filas.reduce((a, f) => a + f.aConservar, 0);
    const tablas = s.filas.filter((f) => f.aBorrar).length;
    const ficheros = s.objetos ? fmt(s.objetos.deLaApp.length) : 'ninguno (sin acceso al almacén)';
    l.push('', `RESUMEN · filas que se borrarían: ${fmt(borrar)} (en ${fmt(tablas)} tablas) · ficheros: ${ficheros} · filas que se quedan: ${fmt(conservar)}`);
  }
  return l;
}

/** Un punto de una lista («  - texto»), con las lineas siguientes sangradas debajo del texto. */
function parrafo(texto: string): string[] {
  return envolver(texto.split(' '), '    ', ' ').map((l, i) => (i === 0 ? `  - ${l.slice(4)}` : l));
}

/** Parte una lista en lineas de unos 100 caracteres. */
function envolver(piezas: string[], sangria: string, sep = ' · '): string[] {
  const out: string[] = [];
  let linea = '';
  for (const p of piezas) {
    if (linea && sangria.length + linea.length + sep.length + p.length > 100) {
      out.push(sangria + linea);
      linea = p;
    } else linea = linea ? `${linea}${sep}${p}` : p;
  }
  if (linea) out.push(sangria + linea);
  return out;
}

// ---------------- Borrado ----------------

export interface ResultadoVaciado {
  porTabla: Map<string, number>;
  ficheros: number;
}

/**
 * Borra, en lotes y tabla a tabla en el orden de las claves ajenas, todo lo
 * que la simulacion marca. Solo DELETE y UPDATE de datos: el esquema no se
 * toca. Despues borra del almacen los ficheros de la app y deja la marca en
 * AuditLog.
 */
export async function vaciar(
  ctx: Contexto,
  opciones: { conservar: readonly string[]; objetos: readonly Objeto[]; copia: string; progreso?: (texto: string) => void },
): Promise<ResultadoVaciado> {
  const { db, clasificacion, almacen } = ctx;
  const avisar = opciones.progreso ?? (() => undefined);
  const porNombre = new Map(clasificacion.tablas.map((t) => [t.nombre, t]));
  const porTabla = new Map<string, number>();
  for (const nombre of ordenDeBorrado(clasificacion.tablas)) {
    const t = porNombre.get(nombre)!;
    const cond = condicionBorrado(t, opciones.conservar);
    if (!cond) continue;
    const lote = t.columnas.some((c) => c.tipo === 'Bytes') ? LOTE_BORRADO_BINARIO : LOTE_BORRADO;
    // Padre e hijas en la misma tabla: primero se sueltan, asi ningun DELETE
    // arrastra en cascada filas de otro lote.
    for (const col of t.autoReferencias) {
      for (;;) {
        const n = await db.$executeRawUnsafe(
          `UPDATE ${id(nombre)} SET ${id(col)} = NULL WHERE (${cond.sql}) AND ${id(col)} IS NOT NULL LIMIT ${lote}`,
          ...cond.params,
        );
        if (n < lote) break;
      }
    }
    let total = 0;
    for (;;) {
      const n = await db.$executeRawUnsafe(`DELETE FROM ${id(nombre)} WHERE ${cond.sql} LIMIT ${lote}`, ...cond.params);
      total += n;
      if (n === 0) break;
    }
    porTabla.set(nombre, total);
    if (total) avisar(`  ${nombre}: ${plural(total, 'fila borrada', 'filas borradas')}`);
  }

  let ficheros = 0;
  if (opciones.objetos.length) {
    await almacen.borrar(opciones.objetos);
    ficheros = opciones.objetos.length;
    avisar(`  Ficheros borrados: ${ficheros}`);
  }

  const filas = [...porTabla.values()].reduce((a, n) => a + n, 0);
  await db.auditLog.create({
    data: {
      id: randomUUID(),
      userId: opciones.conservar[0],
      companyId: null,
      action: ACCION_VACIADO,
      resourceType: 'PLATAFORMA',
      resourceId: null,
      meta: {
        motivo: 'Entrega a cero: se borran todas las empresas y sus datos de prueba',
        copiaLocal: opciones.copia,
        filasBorradas: filas,
        ficherosBorrados: ficheros,
        administradoresConservados: opciones.conservar.length,
        porTabla: Object.fromEntries([...porTabla.entries()].filter(([, n]) => n)),
      },
    },
  });
  return { porTabla, ficheros };
}

// ---------------- Comprobacion final ----------------

export interface Comprobacion {
  ok: boolean;
  /** false: la base no tiene el esquema de esta version y no se ha comprobado nada. */
  esquemaOk: boolean;
  lineas: string[];
}

/**
 * Comprueba que la base ha quedado como se entrega: ninguna empresa ni dato de
 * empresa, solo administradores globales (alguno activo) y ninguna fila
 * huerfana. Se puede repetir mas tarde: los accesos del administrador (LOGIN
 * en AuditLog, sus contadores de Carmen...) no cuentan como fallo.
 */
export async function comprobar(ctx: Contexto, manifiesto?: Manifiesto | null): Promise<Comprobacion> {
  const { db, clasificacion, almacen } = ctx;
  const lineas: string[] = [];
  const fallos: string[] = [];
  const tablas = clasificacion.tablas;

  const estado = await comprobarEsquema(db, tablas);
  if (!esquemaCorrecto(estado)) {
    return { ok: false, esquemaOk: false, lineas: ['La base no tiene el esquema de esta versión: no se puede comprobar.', ...motivosEsquema(estado).map((m) => `  - ${m}`), PARADA_ESQUEMA] };
  }

  const usuarios = await leerUsuarios(db);
  const admins = usuarios.filter((u) => u.adminGlobal);
  const idsAdmins = admins.map((u) => u.id);

  lineas.push('Recuento de filas por tabla:');
  const aCero: string[] = [];
  const otras: string[] = [];
  for (const t of tablas) {
    const n = await contar(db, t.nombre);
    if (t.destino === 'VACIAR') {
      if (!n) {
        aCero.push(t.nombre);
        continue;
      }
      fallos.push(`${t.nombre} tiene ${plural(n, 'fila', 'filas')} y tendría que estar vacía.`);
      otras.push(`  ${punteada(t.nombre, `${fmt(n)}  <-- MAL: tendría que estar a 0`)}`);
      continue;
    }
    const huerfanas = t.destino === 'PARCIAL' ? await huerfanasDe(db, t, idsAdmins) : 0;
    if (huerfanas) fallos.push(`${t.nombre}: quedan ${plural(huerfanas, 'fila', 'filas')} de empresas o de usuarios borrados.`);
    let nota = `${fmt(n)} (${TEXTO_DESTINO[t.destino]})`;
    const copia = manifiesto?.tablas.find((x) => x.tabla === t.nombre);
    if (t.destino === 'CONSERVAR' && copia && copia.filas !== n) {
      fallos.push(`${t.nombre} tenía ${plural(copia.filas, 'fila', 'filas')} y ahora tiene ${fmt(n)}: se tenía que conservar igual.`);
      nota += '  <-- MAL';
    }
    if (huerfanas) nota += `  <-- MAL (${fmt(huerfanas)} sueltas)`;
    otras.push(`  ${punteada(t.nombre, nota)}`);
  }
  const vaciables = tablas.filter((t) => t.destino === 'VACIAR').length;
  lineas.push(`  A 0: ${fmt(aCero.length)} de las ${fmt(vaciables)} tablas que se vacían${aCero.length === vaciables ? '' : ' (las demás, abajo)'}.`);
  lineas.push(...envolver(aCero, '    '));
  lineas.push(...otras);


  const noAdmins = usuarios.filter((u) => !u.adminGlobal);
  if (noAdmins.length) fallos.push(`Quedan ${noAdmins.length} usuarios que no son administradores globales.`);
  const activos = admins.filter((u) => u.activo);
  if (!activos.length) fallos.push('No queda ningún administrador global activo: nadie podría entrar.');
  lineas.push('', 'Administradores que quedan:');
  for (const a of admins) {
    const enCopia = manifiesto?.admins.find((x) => x.id === a.id);
    const clave = enCopia ? (enCopia.huellaClave === huella(a.passwordHash) ? 'contraseña sin cambios' : 'LA CONTRASEÑA HA CAMBIADO') : 'contraseña guardada';
    if (enCopia && enCopia.huellaClave !== huella(a.passwordHash)) fallos.push(`La contraseña de ${a.email} ha cambiado durante el vaciado.`);
    lineas.push(`  ${a.email} · ${a.activo ? 'activo' : 'DESACTIVADO'} · ${a.empresas} empresas · ${clave}`);
  }
  if (manifiesto) {
    for (const a of manifiesto.admins) if (!admins.some((x) => x.id === a.id)) fallos.push(`El administrador ${a.email} ya no está.`);
  }

  if (almacen.tipo !== 'ninguno') {
    const quedan = (await almacen.listar()).filter((o) => esDeLaApp(o.clave));
    if (quedan.length) fallos.push(`Quedan ${quedan.length} ficheros de la app en el almacén.`);
    lineas.push('', `Ficheros de la app en el almacén: ${fmt(quedan.length)}${quedan.length ? '  <-- MAL' : ''}`);
  } else {
    lineas.push('', 'Ficheros: sin acceso al almacén, no se han comprobado (ni borrado).');
  }

  const series = tablas.some((t) => t.nombre === 'InvoiceSeries') ? await contar(db, 'InvoiceSeries') : 0;
  if (!series) {
    lineas.push(
      'Series de facturación: no queda ninguna. Cada empresa nueva crea las suyas (A, C, R y P) al primer uso, empezando',
      'en 0, así que su primera factura será la A-1, la primera rectificativa la R-1 y la primera proforma la P-1.',
    );
  }

  if (fallos.length) {
    lineas.push('', 'NO CUADRA:');
    for (const f of fallos) lineas.push(`  - ${f}`);
  }
  return { ok: fallos.length === 0, esquemaOk: true, lineas };
}

/** Filas de una tabla PARCIAL que no deberian quedar (de empresas o de usuarios que ya no existen). */
async function huerfanasDe(db: PrismaClient, t: Tabla, admins: readonly string[]): Promise<number> {
  const usuarios = `(SELECT ${id('id')} FROM ${id('User')})`;
  switch (t.nombre) {
    case 'User':
      return contar(db, 'User', { sql: `${id('isGlobalAdmin')} = 0`, params: [] });
    case 'RevokedToken':
      return contar(db, 'RevokedToken', { sql: `${id('userId')} NOT IN ${usuarios}`, params: [] });
    case 'CarmenContador':
      return contar(db, 'CarmenContador', {
        sql: `${id('clave')} LIKE 'empresa:%' OR (${id('clave')} LIKE 'usuario:%' AND SUBSTRING_INDEX(SUBSTRING_INDEX(${id('clave')}, ':', 2), ':', -1) NOT IN ${usuarios})`,
        params: [],
      });
    case 'ChartOfAccounts':
      return contar(db, 'ChartOfAccounts', { sql: `${id('companyId')} IS NOT NULL`, params: [] });
    case 'AuditLog':
      return contar(db, 'AuditLog', { sql: `${id('companyId')} IS NOT NULL OR ${id('userId')} NOT IN ${usuarios}`, params: [] });
    case 'VerifactuBitacora':
      return contar(db, 'VerifactuBitacora', { sql: `${id('companyId')} IS NOT NULL OR ${id('usuarioId')} NOT IN ${usuarios}`, params: [] });
    default: {
      // PARCIAL nueva sin comprobacion propia: lo que su condicion borraria.
      const cond = admins.length ? condicionBorrado(t, admins) : null;
      return cond ? contar(db, t.nombre, cond) : 0;
    }
  }
}
