/**
 * Vaciado de produccion para la entrega «todo a cero»: que se hace con cada
 * tabla y en que orden se borra.
 *
 * Las tablas salen de la DMMF de Prisma (todos los modelos del esquema), no de
 * una lista escrita a mano. Una tabla nueva con companyId, o que cuelga por
 * clave ajena de una que lo tiene, se vacia sola. Una tabla nueva que no es de
 * ninguna empresa y no esta en REGLAS queda «sin clasificar», y el script se
 * para hasta que alguien decida que hacer con ella.
 *
 * Solo se borran DATOS: nada de este modulo toca el esquema.
 */
import { Prisma } from '@prisma/client';

export type Destino = 'VACIAR' | 'PARCIAL' | 'CONSERVAR';

export interface Columna {
  nombre: string;
  /** Tipo de Prisma (String, Int, Decimal, DateTime, Json, Bytes...) o el nombre del enum. */
  tipo: string;
}

export interface Relacion {
  padre: string;
  columnas: string[];
  columnasPadre: string[];
  /** Cascade, Restrict, SetNull, NoAction... (el de Prisma; null = el de por defecto). */
  alBorrar: string | null;
  obligatoria: boolean;
}

export interface Tabla {
  /** Nombre de la tabla en la base (el del modelo: el esquema no usa @@map). */
  nombre: string;
  destino: Destino;
  /** Por que, en castellano, para la simulacion y la documentacion. */
  motivo: string;
  columnas: Columna[];
  /** Columnas de la clave primaria. */
  clave: string[];
  /** 'companyId' si la tabla lo tiene. */
  columnaEmpresa: string | null;
  /** Claves ajenas a OTRAS tablas. */
  relaciones: Relacion[];
  /** Columnas que apuntan a la propia tabla (padre e hijas en la misma tabla). */
  autoReferencias: string[];
  /** Para contar por empresa una tabla sin companyId: a traves de su padre. */
  empresaPor: { padre: string; columna: string; columnaPadre: string } | null;
}

export interface Clasificacion {
  tablas: Tabla[];
  /** Tablas que no son de ninguna empresa y no tienen regla: el script se para. */
  sinClasificar: string[];
}

/**
 * Tablas que no se vacian enteras por tener companyId (o colgar de una que lo
 * tiene). Cada una con su motivo. Si el esquema cambia, revisar esta lista.
 */
export const REGLAS: Record<string, { destino: Destino; motivo: string }> = {
  Company: {
    destino: 'VACIAR',
    motivo: 'Las empresas. Se borran todas: las reales se dan de alta de nuevo al entregar.',
  },
  SupplierAudit: {
    destino: 'VACIAR',
    motivo: 'Historial de cambios de los proveedores. No tiene companyId, pero cada fila es de un proveedor (supplierId) de una empresa.',
  },
  User: {
    destino: 'PARCIAL',
    motivo: 'Se conservan los administradores globales que confirmes, con su contraseña. El resto de usuarios se borra.',
  },
  RevokedToken: {
    destino: 'PARCIAL',
    motivo:
      'Sesiones cerradas. Se conservan las del administrador (así una sesión suya ya cerrada sigue sin valer) y se borran las del resto de usuarios.',
  },
  CarmenContador: {
    destino: 'PARCIAL',
    motivo:
      'Contadores de Carmen. Se conserva el gasto de la IA del mes en toda la plataforma (claves global:) y los contadores del administrador; se borran los de las empresas y los de los usuarios que se borran.',
  },
  ChartOfAccounts: {
    destino: 'PARCIAL',
    motivo: 'Plan de cuentas. Se borran todas las cuentas de las empresas; se conservan las del plan base común (sin empresa), si las hay.',
  },
  AuditLog: {
    destino: 'PARCIAL',
    motivo:
      'Registro de auditoría. Se borra entero salvo el historial de los ajustes de la plataforma que hizo el administrador. Al terminar queda una fila nueva con la marca del vaciado.',
  },
  ChartOfAccountsVersion: {
    destino: 'CONSERVAR',
    motivo: 'Versión del PGC, común a todas las empresas: el plan de cuentas de cada empresa nueva apunta a ella.',
  },
  TipoCambioBce: {
    destino: 'CONSERVAR',
    motivo: 'Tipos de cambio publicados por el BCE. Son datos públicos y no son de ninguna empresa.',
  },
  AjustePlataforma: {
    destino: 'CONSERVAR',
    motivo: 'Ajustes de toda la plataforma (la red de seguridad de VERI*FACTU). Los decide el administrador global y no son de ninguna empresa.',
  },
  // VERI*FACTU (fase F1). Todavia no se envia nada a la AEAT (el envio es la
  // fase F3): lo que hay son registros del entorno de PRUEBAS, sin efecto
  // fiscal. Si alguna fila fuera del entorno de PRODUCCION, o alguna empresa
  // tuviera VERI*FACTU activo, comprobarVerifactu (vaciado.ts) para el script
  // antes de copiar ni borrar nada. Con companyId se vaciarian solas; la regla
  // deja escrito el porque.
  VerifactuCadena: {
    destino: 'VACIAR',
    motivo: 'Cabeza de la cadena de registros de VERI*FACTU de cada empresa (último registro y su huella). Se borra con sus registros: una empresa nueva empieza su cadena desde el primero.',
  },
  VerifactuRegistro: {
    destino: 'VACIAR',
    motivo:
      'Registros de alta de VERI*FACTU de las facturas emitidas, del entorno de pruebas de la AEAT. La app no deja cambiarlos ni borrarlos, así que el script los borra con SQL, antes que sus facturas.',
  },
  VerifactuLote: {
    destino: 'VACIAR',
    motivo: 'Envíos de registros de VERI*FACTU a la AEAT de cada empresa. Hoy la app todavía no envía nada.',
  },
  VerifactuCertificado: {
    destino: 'VACIAR',
    motivo: 'Certificado electrónico de cada empresa para VERI*FACTU (cifrado). Se borra con la empresa: al darla de alta de nuevo hay que volver a subirlo.',
  },
  VerifactuBitacora: {
    destino: 'PARCIAL',
    motivo:
      'Bitácora de VERI*FACTU. Se borran los sucesos de las empresas y los de los usuarios que se borran; se conservan los de toda la plataforma (sin empresa) sin usuario o del administrador, como los ajustes de la plataforma.',
  },
  ImagenFactura: {
    destino: 'VACIAR',
    motivo: 'Logo de la marca y sello de cada empresa para la plantilla B de las facturas. Van dentro de la base y se borran con la empresa.',
  },
};

/** Tablas que no tienen clave ajena pero se cuentan por empresa a traves de otra. */
const EMPRESA_POR_COLUMNA: Record<string, { padre: string; columna: string; columnaPadre: string }> = {
  SupplierAudit: { padre: 'Supplier', columna: 'supplierId', columnaPadre: 'id' },
};

type ModeloDmmf = (typeof Prisma.dmmf.datamodel.models)[number];

function aTabla(m: ModeloDmmf): Omit<Tabla, 'destino' | 'motivo' | 'empresaPor'> {
  const columnas: Columna[] = m.fields
    .filter((f) => f.kind === 'scalar' || f.kind === 'enum')
    .map((f) => ({ nombre: f.dbName ?? f.name, tipo: f.type as string }));
  const clave = m.primaryKey?.fields?.length ? [...m.primaryKey.fields] : m.fields.filter((f) => f.isId).map((f) => f.name);
  const relaciones: Relacion[] = [];
  const autoReferencias: string[] = [];
  for (const f of m.fields) {
    if (f.kind !== 'object' || !f.relationFromFields?.length) continue;
    if (f.type === m.name) {
      autoReferencias.push(...f.relationFromFields);
      continue;
    }
    relaciones.push({
      padre: f.type as string,
      columnas: [...f.relationFromFields],
      columnasPadre: [...(f.relationToFields ?? [])],
      alBorrar: (f.relationOnDelete as string | undefined) ?? null,
      obligatoria: f.isRequired,
    });
  }
  const empresa = m.fields.find((f) => f.name === 'companyId' && f.kind === 'scalar');
  return { nombre: m.dbName ?? m.name, columnas, clave, columnaEmpresa: empresa ? 'companyId' : null, relaciones, autoReferencias };
}

/**
 * Clasifica todos los modelos del esquema. Orden de las reglas:
 *  1. REGLAS (decision escrita para esa tabla);
 *  2. companyId obligatorio: datos de una empresa, se vacia;
 *  3. sin companyId, con clave ajena obligatoria a una tabla que se vacia
 *     entera: cuelga de una empresa, se vacia;
 *  4. lo demas: sin clasificar.
 */
export function clasificarTablas(modelos: readonly ModeloDmmf[] = Prisma.dmmf.datamodel.models): Clasificacion {
  const base = new Map(modelos.map((m) => [m.name, { m, t: aTabla(m) }]));
  const destino = new Map<string, { destino: Destino; motivo: string }>();

  for (const [nombre, { m }] of base) {
    const regla = REGLAS[nombre];
    if (regla) {
      destino.set(nombre, regla);
      continue;
    }
    const empresa = m.fields.find((f) => f.name === 'companyId' && f.kind === 'scalar');
    if (empresa?.isRequired) destino.set(nombre, { destino: 'VACIAR', motivo: 'Datos de una empresa (tiene companyId).' });
  }
  // Las que cuelgan de una que se vacia (puede haber varios niveles).
  let cambio = true;
  while (cambio) {
    cambio = false;
    for (const [nombre, { t }] of base) {
      if (destino.has(nombre) || t.columnaEmpresa) continue;
      const padre = t.relaciones.find((r) => r.obligatoria && destino.get(r.padre)?.destino === 'VACIAR');
      if (padre) {
        destino.set(nombre, { destino: 'VACIAR', motivo: `Cuelga de ${padre.padre}, que es de una empresa.` });
        cambio = true;
      }
    }
  }

  const tablas: Tabla[] = [];
  const sinClasificar: string[] = [];
  for (const [nombre, { t }] of base) {
    const d = destino.get(nombre);
    if (!d) {
      sinClasificar.push(nombre);
      continue;
    }
    tablas.push({ ...t, ...d, empresaPor: empresaPor(t, base) });
  }
  tablas.sort((a, b) => a.nombre.localeCompare(b.nombre));
  return { tablas, sinClasificar: sinClasificar.sort() };
}

function empresaPor(t: Omit<Tabla, 'destino' | 'motivo' | 'empresaPor'>, base: Map<string, { t: Omit<Tabla, 'destino' | 'motivo' | 'empresaPor'> }>): Tabla['empresaPor'] {
  if (t.columnaEmpresa) return null;
  const fija = EMPRESA_POR_COLUMNA[t.nombre];
  if (fija) return fija;
  const r = t.relaciones.find((x) => x.obligatoria && x.columnas.length === 1 && base.get(x.padre)?.t.columnaEmpresa);
  return r ? { padre: r.padre, columna: r.columnas[0], columnaPadre: r.columnasPadre[0] ?? 'id' } : null;
}

/**
 * Orden de borrado: cada tabla despues de todas las que la apuntan con una
 * clave ajena (las hijas antes que las padres). Asi ni RESTRICT frena un
 * borrado ni CASCADE ni SET NULL tienen nada que hacer: cada DELETE solo toca
 * su tabla y los lotes no crecen. Las referencias a la propia tabla se ponen a
 * NULL antes de borrar (ver vaciado.ts).
 */
export function ordenDeBorrado(tablas: readonly Pick<Tabla, 'nombre' | 'relaciones'>[]): string[] {
  const nombres = new Set(tablas.map((t) => t.nombre));
  const hijas = new Map<string, Set<string>>(tablas.map((t) => [t.nombre, new Set<string>()]));
  for (const t of tablas) for (const r of t.relaciones) if (nombres.has(r.padre)) hijas.get(r.padre)!.add(t.nombre);
  const orden: string[] = [];
  const hecho = new Set<string>();
  while (orden.length < tablas.length) {
    const listas = [...nombres].filter((n) => !hecho.has(n) && [...hijas.get(n)!].every((h) => hecho.has(h))).sort();
    if (!listas.length) {
      const resto = [...nombres].filter((n) => !hecho.has(n));
      throw new Error(`Hay claves ajenas en círculo entre estas tablas: ${resto.join(', ')}. Revisa el orden de borrado.`);
    }
    for (const n of listas) {
      orden.push(n);
      hecho.add(n);
    }
  }
  return orden;
}

/** Orden para restaurar una copia: el inverso (las padres antes que las hijas). */
export const ordenDeRestauracion = (tablas: readonly Pick<Tabla, 'nombre' | 'relaciones'>[]): string[] => ordenDeBorrado(tablas).reverse();

/** Identificador entre comillas invertidas. */
export const id = (nombre: string): string => '`' + nombre.replace(/`/g, '``') + '`';

/** Lista de marcadores para un IN (...) (al menos uno). */
const marcadores = (n: number): string => Array.from({ length: n }, () => '?').join(', ');

/** Acciones de AuditLog que deja el propio vaciado (y su restauracion): se conservan. */
export const MARCAS_AUDITORIA = ['VACIADO_PRODUCCION', 'VACIADO_RESTAURADO'] as const;

export interface Condicion {
  sql: string;
  params: unknown[];
}

/**
 * Filas que se BORRAN de cada tabla. null = la tabla se conserva entera.
 * `admins`: ids de los administradores globales que se conservan (al menos uno).
 */
export function condicionBorrado(t: Pick<Tabla, 'nombre' | 'destino'>, admins: readonly string[]): Condicion | null {
  if (t.destino === 'CONSERVAR') return null;
  if (t.destino === 'VACIAR') return { sql: '1 = 1', params: [] };
  if (!admins.length) throw new Error('No hay ningún administrador que conservar.');
  const enAdmins = marcadores(admins.length);
  switch (t.nombre) {
    case 'User':
      return { sql: `${id('id')} NOT IN (${enAdmins})`, params: [...admins] };
    case 'RevokedToken':
      return { sql: `${id('userId')} NOT IN (${enAdmins})`, params: [...admins] };
    case 'CarmenContador':
      return {
        sql: `NOT (${id('clave')} LIKE 'global:%' OR ${admins.map(() => `${id('clave')} LIKE CONCAT('usuario:', ?, ':%')`).join(' OR ')})`,
        params: [...admins],
      };
    case 'ChartOfAccounts':
      return { sql: `${id('companyId')} IS NOT NULL`, params: [] };
    case 'AuditLog':
      // Se quedan, del administrador y sin empresa: los cambios de los ajustes
      // de la plataforma y las marcas de vaciados y restauraciones anteriores.
      return {
        sql: `NOT (${id('companyId')} IS NULL AND ${id('userId')} IN (${enAdmins}) AND (${id('resourceType')} = 'AJUSTE_PLATAFORMA' OR ${id('action')} IN (${MARCAS_AUDITORIA.map(() => '?').join(', ')})))`,
        params: [...admins, ...MARCAS_AUDITORIA],
      };
    case 'VerifactuBitacora':
      // Se quedan los sucesos de la plataforma (sin empresa) sin usuario o del administrador.
      return {
        sql: `NOT (${id('companyId')} IS NULL AND (${id('usuarioId')} IS NULL OR ${id('usuarioId')} IN (${enAdmins})))`,
        params: [...admins],
      };
    default:
      // Una tabla PARCIAL nueva sin su condicion: mejor parar que adivinar.
      throw new Error(`La tabla ${t.nombre} está marcada como borrado parcial pero no tiene condición. Revisa vaciadoProduccion/tablas.ts.`);
  }
}

/** Nombre corto del destino para la pantalla. */
export const TEXTO_DESTINO: Record<Destino, string> = {
  VACIAR: 'se vacía',
  PARCIAL: 'se vacía en parte',
  CONSERVAR: 'se conserva',
};
