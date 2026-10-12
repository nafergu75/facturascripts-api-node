/**
 * Despues de traer la contabilidad de 2026: las comprobaciones de A4 en vivo
 * (lo que se arregla fuera de los ficheros: bancos, datos fiscales, datos de
 * la empresa, series, fichas de clientes y proveedores), aceptar un punto de
 * «Faltan datos» con un motivo, escribir los extractos y los datos fiscales,
 * crear las series de 2027 y volver 2026 a la app.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { FILTRO_ASIENTOS_APERTURA } from '../../domain/asientosCierre';
import { badRequest, conflict, notFound } from '../../utils/http-errors';
import { aCentimos, importeTexto } from '../../utils/money';
import { registrarAuditoria } from '../auditoria.service';
import { rangoEjercicio, OPCIONES_TX } from '../puestaEnMarcha/asientosEnBloque';
import { actualizarSerie, crearSerie, listarSeries } from '../series.service';
import { EJERCICIO_ARRANQUE, type VistaCarga } from './analisis.service';
import { aplicarBancos, saldos572 } from './bancos.service';
import { ajustesDe, limpiarBancos, limpiarDatosFiscales, validarEjercicio, type CargaFila } from './cargas.service';
import { esPuntoVivo, juntarComprobaciones, type AvisoAceptado, type NivelCarga, type PuntoComprobacion, type ResultadoComprobaciones } from './comprobaciones';
import type { AjusteBanco, DatosFiscales } from './datos';
import { puntosVivos } from './vivas.service';

const objeto = (v: Prisma.JsonValue | null | undefined): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const json = (v: unknown) => v as Prisma.InputJsonValue;

/** Lo que la carga guarda en su resumen. */
export interface ResumenCarga {
  vista?: VistaCarga;
  confirmacion?: { huella: string; nivel: NivelCarga; comprobaciones: ResultadoComprobaciones; en: string };
  final?: { nivel: NivelCarga; en: string };
  bancos?: Record<string, AjusteBanco>;
  datosFiscales?: DatosFiscales;
  resultadoDeclarado?: number | null;
  avisosAceptados?: AvisoAceptado[];
}

export const resumenDe = (c: { resumen: Prisma.JsonValue | null }): ResumenCarga => objeto(c.resumen) as ResumenCarga;

/** La carga vigente (CONFIRMADA) de la empresa, o null. */
export async function cargaVigente(companyId: string, ejercicio = EJERCICIO_ARRANQUE): Promise<CargaFila | null> {
  return prisma.cargaArranque.findFirst({ where: { companyId, ejercicio, estado: 'CONFIRMADA' } });
}

/** Lineas de la apertura vigente del ejercicio (la de la carga y sus ajustes). */
export async function lineasApertura(companyId: string, ejercicio: number) {
  const lineas = await prisma.journalEntryLine.findMany({
    where: { companyId, entry: { estado: 'POSTED', ...FILTRO_ASIENTOS_APERTURA, fecha: rangoEjercicio(ejercicio) } },
    select: { accountCode: true, accountName: true, debe: true, haber: true },
  });
  return lineas.map((l) => ({ cuenta: l.accountCode, nombre: l.accountName, debe: Number(l.debe), haber: Number(l.haber) }));
}

export interface ComprobacionesArranque extends ResultadoComprobaciones {
  carga: { id: string; version: number; tipo: string; estado: string };
  aceptados: AvisoAceptado[];
  /** «Todo correcto»: el arranque queda completado. */
  completado: boolean;
  /** Las comprobaciones son las del resumen de un borrador (aun sin importar). */
  deBorrador: boolean;
}

/** A4 en vivo de la carga vigente; sin carga vigente, las del borrador; sin nada, null. */
export async function comprobacionesArranque(companyId: string, ejercicio = EJERCICIO_ARRANQUE): Promise<ComprobacionesArranque | null> {
  const anio = ejercicio - 1;
  const vigente = await cargaVigente(companyId, ejercicio);
  if (!vigente) {
    const borrador = await prisma.cargaArranque.findFirst({ where: { companyId, ejercicio, estado: { in: ['BORRADOR', 'APLICANDO'] } }, orderBy: { version: 'desc' } });
    const vista = borrador ? resumenDe(borrador).vista : undefined;
    if (!borrador || !vista) return null;
    return {
      ...vista.comprobaciones,
      carga: { id: borrador.id, version: borrador.version, tipo: borrador.tipo, estado: borrador.estado },
      aceptados: [],
      completado: false,
      deBorrador: true,
    };
  }
  const resumen = resumenDe(vigente);
  const base = resumen.confirmacion?.comprobaciones ?? { puntos: [], excluidos: [] };
  const vivos = await puntosVivos(companyId, ejercicio, {
    apertura: await lineasApertura(companyId, ejercicio),
    bancos: resumen.bancos ?? {},
    datosFiscales: resumen.datosFiscales ?? {},
    importada: true,
  });
  const extra: PuntoComprobacion[] = [];
  // El resultado de 2026 escrito despues de traer la carga.
  const resultadoSys = resumen.vista?.apertura?.resultado;
  const declarado = resumen.resultadoDeclarado;
  if (declarado !== undefined && declarado !== null && resultadoSys !== undefined) {
    if (aCentimos(declarado) !== aCentimos(resultadoSys)) {
      extra.push({
        clave: 'resultado-declarado',
        nivel: 'AVISO',
        texto: `El resultado que has escrito (${importeTexto(declarado)}) no coincide con el del sumas y saldos (${importeTexto(resultadoSys)}). Revísalo con la gestoría.`,
      });
    }
  }
  const sustituir = (clave: string) => esPuntoVivo(clave) || clave === 'terceros:sin-ficha' || (clave === 'resultado-declarado' && declarado !== undefined && declarado !== null);
  const r = juntarComprobaciones(base, [...vivos.puntos, ...extra], anio, resumen.avisosAceptados ?? [], sustituir);
  return {
    ...r,
    carga: { id: vigente.id, version: vigente.version, tipo: vigente.tipo, estado: vigente.estado },
    completado: r.nivel === 'CORRECTO',
    deBorrador: false,
  };
}

async function exigirVigente(companyId: string, ejercicio: number): Promise<CargaFila> {
  const c = await cargaVigente(companyId, ejercicio);
  if (!c) throw conflict(`Todavía no has traído la contabilidad de ${ejercicio - 1}: escríbelo en el resumen de la carga antes de confirmarla.`);
  return c;
}

/** Acepta un punto de «Faltan datos» con un motivo (deja de salir en el aviso del panel). */
export async function aceptarAviso(companyId: string, ejercicioRaw: unknown, clave: string, motivoRaw: unknown, userId: string) {
  const ejercicio = validarEjercicio(ejercicioRaw);
  const motivo = String(motivoRaw ?? '').trim();
  if (motivo.length < 3) throw badRequest('Escribe por qué aceptas este aviso (queda guardado).', { campo: 'motivo' });
  const c = await exigirVigente(companyId, ejercicio);
  const actual = await comprobacionesArranque(companyId, ejercicio);
  const punto = actual?.puntos.find((p) => p.clave === clave);
  if (!punto) throw notFound('Ese aviso ya no está en las comprobaciones.');
  if (punto.nivel !== 'FALTA') throw conflict(punto.nivel === 'ERROR' ? 'Un error no se puede aceptar: hay que corregirlo.' : 'Ese punto no hace falta aceptarlo.');
  const resumen = resumenDe(c);
  const aceptados = [...(resumen.avisosAceptados ?? []).filter((a) => a.clave !== clave), { clave, motivo: motivo.slice(0, 300), userId, en: new Date().toISOString() }];
  await prisma.cargaArranque.update({ where: { id: c.id }, data: { resumen: json({ ...resumen, avisosAceptados: aceptados }) } });
  await registrarAuditoria({ userId, companyId, action: 'ARRANQUE_AVISO_ACEPTADO', resourceType: 'CargaArranque', resourceId: c.id, meta: { clave, motivo, texto: punto.texto } });
  return comprobacionesArranque(companyId, ejercicio);
}

/** Saldos de los extractos a 31-12 despues de traer la carga. */
export async function guardarBancos(companyId: string, ejercicioRaw: unknown, raw: unknown, userId: string) {
  const ejercicio = validarEjercicio(ejercicioRaw);
  const bancos = limpiarBancos(raw);
  const c0 = await exigirVigente(companyId, ejercicio);
  const apertura = saldos572(await lineasApertura(companyId, ejercicio));
  for (const codigo of Object.keys(bancos)) {
    if (!apertura.has(codigo)) throw badRequest(`La ${codigo} no está en la apertura del 1-1-${ejercicio}.`, { campo: 'bancos' });
  }
  const elegidas = Object.entries(bancos).filter(([, b]) => b.bankAccountId);
  if (elegidas.length) {
    const cuentas = await prisma.bankAccount.findMany({ where: { companyId, id: { in: elegidas.map(([, b]) => b.bankAccountId!) } }, select: { id: true, subcuentaCodigo: true } });
    for (const [codigo, b] of elegidas) {
      if (!cuentas.some((x) => x.id === b.bankAccountId && x.subcuentaCodigo === codigo)) {
        throw badRequest(`La cuenta bancaria elegida para la ${codigo} no es de esa subcuenta: elige la que corresponde o escribe su IBAN.`, { campo: 'bancos' });
      }
    }
  }
  const r = await prisma.$transaction(async (tx) => {
    const c = await tx.cargaArranque.findUniqueOrThrow({ where: { id: c0.id } });
    if (c.estado !== 'CONFIRMADA') throw conflict('La carga ha cambiado: vuelve a cargar la página.');
    const anterior = objeto(c.anterior);
    const creado = objeto(c.creado);
    const hecho = await aplicarBancos(tx, companyId, ejercicio - 1, apertura, bancos, anterior, creado);
    const resumen = resumenDe(c);
    await tx.cargaArranque.update({
      where: { id: c.id },
      data: { anterior: json(anterior), creado: json(creado), resumen: json({ ...resumen, bancos: { ...(resumen.bancos ?? {}), ...bancos } }) },
    });
    return hecho;
  }, OPCIONES_TX);
  await registrarAuditoria({ userId, companyId, action: 'ARRANQUE_BANCOS', resourceType: 'CargaArranque', resourceId: c0.id, meta: { bancos, ...r } });
  return comprobacionesArranque(companyId, ejercicio);
}

/** Datos fiscales de 2026 (303 del 4T, cuotas a compensar, bases negativas, deducciones, resultado) despues de traer la carga. */
export async function guardarDatosFiscales(companyId: string, ejercicioRaw: unknown, raw: unknown, userId: string) {
  const ejercicio = validarEjercicio(ejercicioRaw);
  const c = await exigirVigente(companyId, ejercicio);
  const resumen = resumenDe(c);
  const datosFiscales = limpiarDatosFiscales(raw, resumen.datosFiscales ?? {});
  const r = (raw ?? {}) as Record<string, unknown>;
  let resultadoDeclarado = resumen.resultadoDeclarado ?? ajustesDe(c).resultadoDeclarado ?? null;
  if (r.resultadoDeclarado !== undefined) {
    const n = r.resultadoDeclarado === null || r.resultadoDeclarado === '' ? null : Number(String(r.resultadoDeclarado).replace(',', '.'));
    if (n !== null && !Number.isFinite(n)) throw badRequest('Escribe el resultado de 2026 como un importe.', { campo: 'resultadoDeclarado' });
    resultadoDeclarado = n === null ? null : Math.round(n * 100) / 100;
  }
  await prisma.cargaArranque.update({ where: { id: c.id }, data: { resumen: json({ ...resumen, datosFiscales, resultadoDeclarado }) } });
  await registrarAuditoria({ userId, companyId, action: 'ARRANQUE_DATOS_FISCALES', resourceType: 'CargaArranque', resourceId: c.id, meta: { datosFiscales, resultadoDeclarado } });
  return comprobacionesArranque(companyId, ejercicio);
}

/** Datos fiscales guardados en la carga vigente (para el 303 del 1T y el Modelo 200). */
export async function datosFiscalesArrastrados(companyId: string, ejercicio = EJERCICIO_ARRANQUE): Promise<DatosFiscales | null> {
  const c = await cargaVigente(companyId, ejercicio);
  return c ? (resumenDe(c).datosFiscales ?? null) : null;
}

/** «Crear series 2027»: F2027 y R2027 activas y predeterminadas (las de 2026 no se borran). */
export async function crearSeriesDelEjercicio(companyId: string, ejercicioRaw: unknown, userId: string) {
  const ejercicio = validarEjercicio(ejercicioRaw);
  await listarSeries(companyId);
  const hechas: string[] = [];
  for (const [codigo, tipoDocumento, descripcion] of [
    [`F${ejercicio}`, 'FACTURA', `Facturas ${ejercicio}`],
    [`R${ejercicio}`, 'RECTIFICATIVA', `Rectificativas ${ejercicio}`],
  ] as const) {
    const ya = await prisma.invoiceSeries.findUnique({ where: { companyId_codigo: { companyId, codigo } } });
    if (ya && ya.tipoDocumento !== tipoDocumento) throw conflict(`El código ${codigo} ya lo usa otra serie: crea las series a mano en Configuración > Series.`);
    if (!ya) await crearSerie(companyId, { codigo, descripcion, tipoDocumento, activa: true, porDefecto: true });
    else {
      if (!ya.activa) await actualizarSerie(companyId, ya.id, { activa: true });
      if (!ya.porDefecto) await actualizarSerie(companyId, ya.id, { porDefecto: true });
    }
    hechas.push(codigo);
  }
  await registrarAuditoria({ userId, companyId, action: 'ARRANQUE_SERIES', resourceType: 'InvoiceSeries', meta: { series: hechas } });
  return { series: hechas, texto: `Series ${hechas.join(' y ')} listas y predeterminadas para ${ejercicio}. Las de antes siguen ahí.` };
}

/** Vuelve 2026 a la app (solo sin ninguna carga importada o importandose). */
export async function volverLlevanzaApp(companyId: string, ejercicioRaw: unknown, userId: string) {
  const ejercicio = validarEjercicio(ejercicioRaw);
  const anio = ejercicio - 1;
  const cargas = await prisma.cargaArranque.count({ where: { companyId, ejercicio, estado: { in: ['CONFIRMADA', 'APLICANDO'] } } });
  if (cargas) throw conflict(`Hay una contabilidad de ${anio} traída de la gestoría: deshaz antes la carga.`);
  const fy = await prisma.fiscalYear.findFirst({ where: { companyId, label: String(anio) } });
  if (!fy || fy.llevanza !== 'EXTERNA') throw conflict(`${anio} ya se lleva en la app.`);
  await prisma.fiscalYear.update({ where: { id: fy.id }, data: { llevanza: 'APP' } });
  await registrarAuditoria({ userId, companyId, action: 'ARRANQUE_LLEVANZA', resourceType: 'FiscalYear', resourceId: fy.id, meta: { anio, de: 'EXTERNA', a: 'APP' } });
  return { anio, llevanza: 'APP', texto: `${anio} vuelve a llevarse en la app: ya se puede apuntar con fecha de ${anio}.` };
}
