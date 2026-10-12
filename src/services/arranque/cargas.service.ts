/**
 * Cargas de «Traer la contabilidad de 2026» (CargaArranque): el borrador con
 * los ficheros de la gestoria, su analisis y el estado del apartado.
 *
 *  - Hay como mucho un BORRADOR por empresa y ejercicio. Se reutiliza hasta
 *    que se confirma; cada carga confirmada es una version nueva (1, 2...).
 *  - Los ficheros se guardan en el almacenamiento privado, en la carpeta de la
 *    carga (`arranque/<empresa>/<carga>/<huella>`): no caducan como las subidas
 *    por trozos, asi que un borrador de hace dias sigue teniendo sus ficheros.
 *  - El analisis no escribe nada contable: guarda en la carga el resumen, los
 *    ajustes y la huella que la confirmacion tiene que volver a dar.
 */
import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { badRequest, conflict, notFound } from '../../utils/http-errors';
import { deleteObjects, getObjectByKey, putObject } from '../../utils/storage';
import { registrarAuditoria } from '../auditoria.service';
import { esEmpresaEspanola } from '../perfilEmpresa.service';
import type { PermisosAlta } from '../puestaEnMarcha/planAnterior';
import { analizarCarga, EJERCICIO_ARRANQUE, vistaDe, type AnalisisCarga, type VistaCarga } from './analisis.service';
import { limpiarMapeoCampos } from './campos';
import { TIPOS_HOJA, type TipoHoja } from './clasificador';
import { prepararDatos, type AjusteBanco, type AjusteHoja, type AjustesCarga, type DatosFiscales, type FicheroLeible, type TipoCarga } from './datos';
import { EXTENSIONES_CARGA, MAX_FICHEROS_CARGA, TAM_MAX_FICHERO } from './lectorLibros';

export interface FicheroGuardado {
  nombre: string;
  sha256: string;
  tamano: number;
  clave: string;
}

export type CargaFila = Prisma.CargaArranqueGetPayload<object>;

const claveFichero = (companyId: string, cargaId: string, sha: string) => `arranque/${companyId}/${cargaId}/${sha}`;
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** Solo 2027 por ahora. */
export function validarEjercicio(raw: unknown): number {
  const e = Number(raw);
  if (e !== EJERCICIO_ARRANQUE) throw badRequest(`Por ahora solo se puede traer la contabilidad de ${EJERCICIO_ARRANQUE - 1} para empezar ${EJERCICIO_ARRANQUE}.`);
  return e;
}

export const ficherosDe = (c: { ficheros: Prisma.JsonValue }): FicheroGuardado[] => (Array.isArray(c.ficheros) ? (c.ficheros as unknown as FicheroGuardado[]) : []);
export const ajustesDe = (c: { ajustes: Prisma.JsonValue | null }): AjustesCarga => (c.ajustes && typeof c.ajustes === 'object' ? (c.ajustes as AjustesCarga) : {});

/** Importe escrito a mano (admite coma decimal); null si viene vacio. */
function importeManual(v: unknown, texto: string, campo: string): number | null {
  if (v === undefined || v === null || v === '') return null;
  // «1.250,30» (con coma decimal) o «1250.30»: la coma manda si la hay.
  const t = String(v).trim();
  const n = typeof v === 'number' ? v : Number(t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : t);
  if (!Number.isFinite(n)) throw badRequest(`${texto}: escribe un importe (por ejemplo, 1250,30).`, { campo });
  return Math.round(n * 100) / 100;
}

/** Saldos de los extractos a 31-12 por subcuenta 572, validados. */
export function limpiarBancos(raw: unknown): Record<string, AjusteBanco> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw badRequest('Los datos de los bancos no son válidos.');
  const out: Record<string, AjusteBanco> = {};
  for (const [codigo, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^57\d{1,13}$/.test(codigo)) throw badRequest(`«${codigo}» no es una cuenta de bancos (57...).`, { campo: 'bancos' });
    if (!v || typeof v !== 'object') continue;
    const b = v as Record<string, unknown>;
    const banco: AjusteBanco = { saldoExtracto: importeManual(b.saldoExtracto, `Saldo del extracto de la ${codigo}`, `bancos.${codigo}.saldoExtracto`) };
    if (typeof b.bankAccountId === 'string' && b.bankAccountId) banco.bankAccountId = b.bankAccountId.slice(0, 40);
    if (b.nueva && typeof b.nueva === 'object') {
      const n = b.nueva as Record<string, unknown>;
      const iban = String(n.iban ?? '').replace(/\s+/g, '').toUpperCase();
      if (!/^[A-Z]{2}\d{2}[A-Z0-9]{8,30}$/.test(iban)) throw badRequest(`El IBAN de la ${codigo} no es válido.`, { campo: `bancos.${codigo}.iban` });
      banco.nueva = { iban, bancoNombre: n.bancoNombre ? String(n.bancoNombre).slice(0, 120) : null };
    }
    if (b.aceptarDiferencia === true) banco.aceptarDiferencia = true;
    out[codigo] = banco;
  }
  return out;
}

/** Datos fiscales de 2026 escritos a mano, validados. */
export function limpiarDatosFiscales(raw: unknown, previos: DatosFiscales = {}): DatosFiscales {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw badRequest('Los datos fiscales no son válidos.');
  const r = raw as Record<string, unknown>;
  const out: DatosFiscales = { ...previos };
  if (r.resultado303T4 !== undefined) out.resultado303T4 = importeManual(r.resultado303T4, 'Resultado del 303 del 4T', 'resultado303T4');
  if (r.cuotasIvaACompensar !== undefined) {
    const n = importeManual(r.cuotasIvaACompensar, 'Cuotas de IVA a compensar', 'cuotasIvaACompensar');
    if (n !== null && n < 0) throw badRequest('Las cuotas de IVA a compensar se escriben en positivo.', { campo: 'cuotasIvaACompensar' });
    out.cuotasIvaACompensar = n;
  }
  if (r.basesNegativas !== undefined) {
    if (!Array.isArray(r.basesNegativas)) throw badRequest('Las bases imponibles negativas van en una lista.', { campo: 'basesNegativas' });
    out.basesNegativas = r.basesNegativas.slice(0, 30).map((b, i) => {
      const x = (b ?? {}) as Record<string, unknown>;
      const ejercicio = Number(x.ejercicio);
      const importe = importeManual(x.importe, `Base negativa ${i + 1}`, 'basesNegativas');
      if (!Number.isInteger(ejercicio) || ejercicio < 1990 || ejercicio > 2100 || importe === null || importe <= 0) {
        throw badRequest('Cada base imponible negativa lleva su año y un importe positivo.', { campo: 'basesNegativas' });
      }
      return { ejercicio, importe };
    });
  }
  if (r.deducciones !== undefined) {
    if (!Array.isArray(r.deducciones)) throw badRequest('Las deducciones van en una lista.', { campo: 'deducciones' });
    out.deducciones = r.deducciones.slice(0, 30).map((d, i) => {
      const x = (d ?? {}) as Record<string, unknown>;
      const concepto = String(x.concepto ?? '').trim().slice(0, 120);
      const importe = importeManual(x.importe, `Deducción ${i + 1}`, 'deducciones');
      if (!concepto || importe === null || importe <= 0) throw badRequest('Cada deducción lleva su concepto y un importe positivo.', { campo: 'deducciones' });
      return { concepto, importe };
    });
  }
  return out;
}

/** Ajustes que llegan del cliente, validados (tipo, mapeo, exclusiones y datos a mano). */
export function limpiarAjustes(raw: unknown, previos: AjustesCarga = {}): AjustesCarga {
  if (raw === undefined || raw === null) return previos;
  if (typeof raw !== 'object') throw badRequest('Los ajustes de la carga no son válidos.');
  const r = raw as Record<string, unknown>;
  const out: AjustesCarga = { ...previos };
  if (r.tipoCarga !== undefined) {
    if (r.tipoCarga !== 'PROVISIONAL' && r.tipoCarga !== 'DEFINITIVA') throw badRequest('El tipo de carga tiene que ser «Provisional» o «Definitiva».');
    out.tipoCarga = r.tipoCarga;
  }
  if (r.resultadoDeclarado !== undefined) {
    if (r.resultadoDeclarado === null || r.resultadoDeclarado === '') out.resultadoDeclarado = null;
    else {
      const n = Number(r.resultadoDeclarado);
      if (!Number.isFinite(n)) throw badRequest('Escribe el resultado de 2026 como un importe (por ejemplo, 7200,50).');
      out.resultadoDeclarado = Math.round(n * 100) / 100;
    }
  }
  if (r.fechaCorte !== undefined) {
    if (r.fechaCorte === null || r.fechaCorte === '') out.fechaCorte = null;
    else if (typeof r.fechaCorte === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.fechaCorte)) out.fechaCorte = r.fechaCorte;
    else throw badRequest('La fecha del sumas y saldos tiene que ser AAAA-MM-DD.');
  }
  if (r.bancos !== undefined) out.bancos = r.bancos === null ? {} : { ...(previos.bancos ?? {}), ...limpiarBancos(r.bancos) };
  if (r.datosFiscales !== undefined) out.datosFiscales = r.datosFiscales === null ? {} : limpiarDatosFiscales(r.datosFiscales, previos.datosFiscales);
  if (r.hojas !== undefined) {
    if (!r.hojas || typeof r.hojas !== 'object') throw badRequest('Los ajustes de las hojas no son válidos.');
    const hojas: Record<string, AjusteHoja> = { ...(previos.hojas ?? {}) };
    for (const [id, v] of Object.entries(r.hojas as Record<string, unknown>)) {
      if (!v || typeof v !== 'object') {
        delete hojas[id];
        continue;
      }
      const a = v as Record<string, unknown>;
      const ajuste: AjusteHoja = {};
      if (a.tipo !== undefined && a.tipo !== null && a.tipo !== '') {
        if (!(TIPOS_HOJA as readonly string[]).includes(String(a.tipo))) throw badRequest('El tipo de hoja elegido no existe.');
        ajuste.tipo = a.tipo as TipoHoja;
      }
      const mapeo = limpiarMapeoCampos(a.mapeo);
      if (mapeo) ajuste.mapeo = mapeo;
      if (a.filaCabecera !== undefined && Number.isInteger(Number(a.filaCabecera)) && Number(a.filaCabecera) >= 0) ajuste.filaCabecera = Number(a.filaCabecera);
      if (a.excluida === true) ajuste.excluida = true;
      hojas[id.slice(0, 200)] = ajuste;
    }
    out.hojas = hojas;
  }
  return out;
}

/** El borrador de la empresa y el ejercicio; si no hay, se crea (version siguiente). */
async function borrador(companyId: string, ejercicio: number, userId: string, tipo: TipoCarga): Promise<CargaFila> {
  for (let intento = 0; ; intento++) {
    const ya = await prisma.cargaArranque.findFirst({ where: { companyId, ejercicio, estado: 'BORRADOR' }, orderBy: { version: 'asc' } });
    if (ya) return ya;
    const max = await prisma.cargaArranque.aggregate({ where: { companyId, ejercicio }, _max: { version: true } });
    try {
      return await prisma.cargaArranque.create({
        data: { companyId, ejercicio, version: (max._max.version ?? 0) + 1, tipo, estado: 'BORRADOR', ficheros: [], ajustes: { tipoCarga: tipo }, createdBy: userId },
      });
    } catch (e) {
      // Dos peticiones a la vez: la otra ya lo ha creado con ese numero de version.
      if (intento < 3 && e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') continue;
      throw e;
    }
  }
}

async function cargaDeEmpresa(companyId: string, ejercicio: number, cargaId: string): Promise<CargaFila> {
  const c = await prisma.cargaArranque.findFirst({ where: { id: cargaId, companyId, ejercicio } });
  if (!c) throw notFound('Esa carga no existe en esta empresa.');
  return c;
}

/** Los ficheros guardados de una carga, para volver a leerlos. */
export async function leerFicherosCarga(c: CargaFila): Promise<FicheroLeible[]> {
  const out: FicheroLeible[] = [];
  for (const f of ficherosDe(c)) {
    const contenido = await getObjectByKey(f.clave);
    if (!contenido) throw conflict(`No encuentro el fichero «${f.nombre}» de la carga: quítalo y vuelve a subirlo.`, { sha256: f.sha256 });
    out.push({ nombre: f.nombre, sha256: f.sha256, contenido });
  }
  return out;
}

/** Analiza una carga con sus ficheros y ajustes (sin escribir nada contable). */
export async function analizarCargaGuardada(c: CargaFila, permisos: PermisosAlta): Promise<AnalisisCarga> {
  const ajustes = ajustesDe(c);
  const datos = prepararDatos(await leerFicherosCarga(c), ajustes);
  return analizarCarga(c.companyId, c.ejercicio, datos, ajustes, permisos, { cargaId: c.id });
}

export interface RespuestaCarga {
  carga: { id: string; version: number; tipo: string; estado: string; ficheros: Array<Omit<FicheroGuardado, 'clave'>> };
  vista: VistaCarga;
  avisos: string[];
}

const cargaPublica = (c: CargaFila): RespuestaCarga['carga'] => ({
  id: c.id,
  version: c.version,
  tipo: c.tipo,
  estado: c.estado,
  ficheros: ficherosDe(c).map(({ clave: _c, ...f }) => f),
});

async function guardarAnalisis(c: CargaFila, a: AnalisisCarga, userId: string): Promise<{ carga: CargaFila; vista: VistaCarga }> {
  const vista = vistaDe(a);
  const carga = await prisma.cargaArranque.update({
    where: { id: c.id },
    data: { huella: a.huella, tipo: a.tipoCarga, resumen: { vista, analizadaEn: new Date().toISOString() } as unknown as Prisma.InputJsonValue },
  });
  await registrarAuditoria({
    userId,
    companyId: c.companyId,
    action: 'ARRANQUE_ANALISIS',
    resourceType: 'CargaArranque',
    resourceId: c.id,
    meta: { version: c.version, nivel: a.comprobaciones.nivel, ficheros: ficherosDe(c).length, huella: a.huella },
  });
  return { carga, vista };
}

/**
 * Sube ficheros al borrador (lo crea si no hay) y lo analiza. Un fichero que
 * ya esta en la carga (misma huella) no se vuelve a guardar.
 */
export async function subirYAnalizar(
  companyId: string,
  ejercicioRaw: unknown,
  userId: string,
  nuevos: Array<{ nombre: string; contenido: Buffer }>,
  ajustesRaw: unknown,
  permisos: PermisosAlta,
): Promise<RespuestaCarga> {
  const ejercicio = validarEjercicio(ejercicioRaw);
  if (!(await esEmpresaEspanola(companyId))) {
    throw badRequest('Traer la contabilidad de la gestoría solo está para las empresas españolas.');
  }
  for (const f of nuevos) {
    if (!EXTENSIONES_CARGA.test(f.nombre)) throw badRequest(`«${f.nombre}»: sube los listados en Excel (.xlsx, .xls), CSV, TXT o la tabla de ContaPlus (.dbf).`);
    if (f.contenido.length > TAM_MAX_FICHERO) throw badRequest(`«${f.nombre}» pesa demasiado (máximo ${TAM_MAX_FICHERO / 1024 / 1024} MB).`);
  }
  const tipo = (ajustesRaw as { tipoCarga?: TipoCarga } | undefined)?.tipoCarga === 'DEFINITIVA' ? 'DEFINITIVA' : 'PROVISIONAL';
  let c = await borrador(companyId, ejercicio, userId, tipo);
  const ficheros = ficherosDe(c);
  const avisos: string[] = [];
  const vigente = await prisma.cargaArranque.findFirst({ where: { companyId, ejercicio, estado: 'CONFIRMADA' }, select: { ficheros: true, version: true } });
  const enVigente = new Set(vigente ? ficherosDe(vigente).map((f) => f.sha256) : []);
  for (const f of nuevos) {
    const sha = sha256(f.contenido);
    if (ficheros.some((x) => x.sha256 === sha)) {
      avisos.push(`«${f.nombre}» ya está en la carga.`);
      continue;
    }
    if (enVigente.has(sha)) avisos.push(`«${f.nombre}» es el mismo fichero que ya trajiste en la versión ${vigente!.version}.`);
    if (ficheros.length >= MAX_FICHEROS_CARGA) throw badRequest(`Una carga admite como mucho ${MAX_FICHEROS_CARGA} ficheros.`);
    const clave = claveFichero(companyId, c.id, sha);
    await putObject(clave, f.contenido);
    ficheros.push({ nombre: f.nombre.slice(0, 200), sha256: sha, tamano: f.contenido.length, clave });
  }
  c = await prisma.cargaArranque.update({
    where: { id: c.id },
    data: { ficheros: ficheros as unknown as Prisma.InputJsonValue, ajustes: limpiarAjustes(ajustesRaw, ajustesDe(c)) as unknown as Prisma.InputJsonValue },
  });
  if (!ficheros.length) throw badRequest('Sube al menos un fichero de la gestoría.');
  const a = await analizarCargaGuardada(c, permisos);
  const r = await guardarAnalisis(c, a, userId);
  return { carga: cargaPublica(r.carga), vista: r.vista, avisos };
}

/** Repite el analisis del borrador con ajustes nuevos (tipo de hoja, columnas, exclusiones, datos a mano). */
export async function reanalizar(companyId: string, ejercicioRaw: unknown, cargaId: string, userId: string, ajustesRaw: unknown, permisos: PermisosAlta): Promise<RespuestaCarga> {
  const ejercicio = validarEjercicio(ejercicioRaw);
  let c = await cargaDeEmpresa(companyId, ejercicio, cargaId);
  if (c.estado !== 'BORRADOR') throw conflict('Esta carga ya está confirmada: para cambiarla, sube los ficheros en una carga nueva.');
  const ajustes = limpiarAjustes(ajustesRaw, ajustesDe(c));
  c = await prisma.cargaArranque.update({ where: { id: c.id }, data: { ajustes: ajustes as unknown as Prisma.InputJsonValue } });
  if (!ficherosDe(c).length) throw badRequest('Sube al menos un fichero de la gestoría.');
  const a = await analizarCargaGuardada(c, permisos);
  const r = await guardarAnalisis(c, a, userId);
  return { carga: cargaPublica(r.carga), vista: r.vista, avisos: [] };
}

/** Quita un fichero del borrador. */
export async function quitarFichero(companyId: string, ejercicioRaw: unknown, cargaId: string, sha: string): Promise<{ carga: RespuestaCarga['carga'] }> {
  const ejercicio = validarEjercicio(ejercicioRaw);
  const c = await cargaDeEmpresa(companyId, ejercicio, cargaId);
  if (c.estado !== 'BORRADOR') throw conflict('Esta carga ya está confirmada: sus ficheros no se pueden quitar.');
  const ficheros = ficherosDe(c);
  const f = ficheros.find((x) => x.sha256 === sha);
  if (!f) throw notFound('Ese fichero no está en la carga.');
  const quedan = ficheros.filter((x) => x.sha256 !== sha);
  const ajustes = ajustesDe(c);
  if (ajustes.hojas) for (const k of Object.keys(ajustes.hojas)) if (k.startsWith(sha.slice(0, 12))) delete ajustes.hojas[k];
  const r = await prisma.cargaArranque.update({
    where: { id: c.id },
    data: { ficheros: quedan as unknown as Prisma.InputJsonValue, ajustes: ajustes as unknown as Prisma.InputJsonValue, huella: null, resumen: Prisma.DbNull },
  });
  await deleteObjects([f.clave]).catch(() => undefined);
  return { carga: cargaPublica(r) };
}

/** Estado del apartado: carga vigente, borrador, la que se esta importando y el historial de versiones. */
export async function estadoArranque(companyId: string, ejercicioRaw: unknown) {
  const ejercicio = validarEjercicio(ejercicioRaw);
  const [cargas, fy] = await Promise.all([
    prisma.cargaArranque.findMany({ where: { companyId, ejercicio }, orderBy: { version: 'desc' } }),
    prisma.fiscalYear.findFirst({ where: { companyId, label: String(ejercicio - 1) }, select: { llevanza: true } }),
  ]);
  const breve = (c: CargaFila) => ({
    ...cargaPublica(c),
    fases: c.fases,
    creadaEn: c.createdAt.toISOString(),
    confirmadaPor: c.confirmadaPor,
    confirmadaEn: c.confirmadaEn?.toISOString() ?? null,
    nivel: (c.resumen as { vista?: VistaCarga; final?: { nivel: string } } | null)?.final?.nivel ?? (c.resumen as { vista?: VistaCarga } | null)?.vista?.comprobaciones.nivel ?? null,
  });
  const borradorFila = cargas.find((c) => c.estado === 'BORRADOR');
  return {
    ejercicio,
    llevanzaAnterior: fy?.llevanza ?? 'APP',
    vigente: cargas.find((c) => c.estado === 'CONFIRMADA') ? breve(cargas.find((c) => c.estado === 'CONFIRMADA')!) : null,
    aplicando: cargas.find((c) => c.estado === 'APLICANDO') ? breve(cargas.find((c) => c.estado === 'APLICANDO')!) : null,
    borrador: borradorFila ? { ...breve(borradorFila), vista: (borradorFila.resumen as { vista?: VistaCarga } | null)?.vista ?? null } : null,
    versiones: cargas.filter((c) => c.estado !== 'BORRADOR').map(breve),
  };
}

export { cargaDeEmpresa, cargaPublica };
