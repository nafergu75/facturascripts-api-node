/**
 * Lo que anaden las lecturas a los "confirmar" de hoy, con dos llamadas para
 * tocar lo menos posible los controladores:
 *
 *  - Antes de registrar: comprobarLecturaParaConfirmar (gastos) o
 *    comprobarRevisionVenta (ventas). Exigen "He revisado" si algo estaba
 *    marcado y, en gastos, vuelven a validar lo que llega en el cuerpo. Una
 *    venta con datos corregidos a mano pasa por comprobarCorreccionVenta, que
 *    vuelve a validar la lectura corregida.
 *  - Despues: vincularLectura. La lectura queda CONFIRMADA (quien y cuando),
 *    el original de un gasto se archiva con la factura y se borra el de la
 *    lectura.
 *
 * Este modulo no importa ingresos-extractor.service (que lo usa). contexto.ts
 * si (separarNumero), pero solo dentro de sus funciones: el ciclo no afecta
 * al cargar los modulos.
 */
import { prisma } from '../../config/database';
import { logger } from '../../config/logger';
import { hoyEspana } from '../../utils/fechas';
import { badRequest, conflict, notFound } from '../../utils/http-errors';
import { deleteObject, getObject } from '../../utils/storage';
import { archivarGastoSinRomper } from '../archivoFacturas.service';
import { perfilEmpresa } from '../perfilEmpresa.service';
import { datosEmpresaValidacion } from './datosEmpresa';
import { lecturaVacia, type Lector, type LecturaNormalizada, type OrigenLectura, type ResultadoValidacion } from './tipos';
import { eleccionGuardada } from './origen-tercero';
import { aplicarCorrecciones, campoDeCorreccion, leerCorrecciones, type CorreccionesVenta } from './correcciones-venta';
import { contextoValidacion } from './contexto';
import { camposDeLectura, estadoPorConfianza, validacionesSincronas, validarLectura } from './validaciones';

export const MENSAJE_FALTA_REVISION = 'Marca que has revisado los datos señalados antes de registrar.';
export const MENSAJE_LECTURA_NO_ENCONTRADA = 'No se encuentra esa lectura.';

type FilaLectura = NonNullable<Awaited<ReturnType<typeof prisma.lecturaDocumento.findFirst>>>;

const pct = (c: number | null | undefined) => (typeof c === 'number' ? ` (confianza ${Math.round(c * 100)} %)` : '');

/** Texto que va delante de las observaciones de la factura. */
export function prefijoObservaciones(origen: string | null, confianza: number | null): string {
  switch (origen as OrigenLectura | null) {
    case 'AZURE':
      return `Leída con Azure${pct(confianza)}.`;
    case 'AZURE_CLAUDE':
      return `Leída con Azure y completada con IA${pct(confianza)}.`;
    case 'FACTURAE':
      return 'Leída del XML Facturae.';
    case 'MANUAL':
      return 'Registrada a mano con el archivo subido al lector.';
    default:
      return 'Leída con IA (Claude).';
  }
}

const necesitaRevision = (fila: { estadoValidacion: string | null }) => fila.estadoValidacion !== null && fila.estadoValidacion !== 'ok';

/** Las validaciones que se guardaron al terminar la lectura. */
const validacionesGuardadas = (fila: { validaciones: unknown }): ResultadoValidacion[] => (Array.isArray(fila.validaciones) ? (fila.validaciones as ResultadoValidacion[]) : []);

export const MENSAJE_FALTA_RECTIFICATIVA = 'Indica qué factura rectifica, o marca que no es una rectificativa.';

/** La lectura es una rectificativa o un abono (V19, en cualquier nivel: las de antes quedaron en error). */
export const esLecturaRectificativa = (fila: { validaciones: unknown }) => validacionesGuardadas(fila).some((v) => v.codigo === 'RECTIFICATIVA');

/** Validaciones que se repiten sobre lo que llega al confirmar un gasto (V14 la sigue haciendo registrarGasto, con su 409). */
const REVALIDAR_GASTO = new Set(['TIPO_IVA', 'NIF_EMISOR', 'EMPRESA', 'FECHA']);

/**
 * El cuerpo del alta de un gasto, como lectura, para volver a validarlo. Con
 * el pais de la ficha del proveedor elegido (paisProveedor: manda sobre lo
 * elegido, ver detectarOrigenTercero). El pais escrito para un proveedor nuevo
 * no es una ficha: cuenta como el de su direccion.
 */
async function lecturaDelCuerpo(
  companyId: string,
  cuerpo: Record<string, unknown>,
  guardada: LecturaNormalizada | null,
): Promise<{ lectura: LecturaNormalizada; paisProveedor: string | null }> {
  const l = lecturaVacia('claude');
  const prov = (cuerpo.proveedor ?? {}) as { id?: unknown; nuevo?: Record<string, unknown> };
  // El proveedor nuevo admite los mismos nombres de campo que su alta (datosProveedor).
  const nuevo = prov.nuevo ?? {};
  const texto = (x: unknown) => (typeof x === 'string' && x.trim() ? x : null);
  let nif: string | null = texto(nuevo.nifCif ?? nuevo.cifnif ?? nuevo.nif);
  let nombre: string | null = texto(nuevo.nombreFiscal ?? nuevo.nombre ?? nuevo.razonsocial);
  const paisNuevo: string | null = texto(nuevo.pais);
  let paisProveedor: string | null = null;
  if (!nif && typeof prov.id === 'string') {
    const elegido = await prisma.supplier.findFirst({ where: { id: prov.id, companyId }, select: { nifCif: true, nombreFiscal: true, pais: true } });
    nif = elegido?.nifCif ?? null;
    nombre = elegido?.nombreFiscal ?? null;
    paisProveedor = elegido?.pais ?? null;
  }
  // La direccion leida del proveedor (su pais) sigue contando si no hay ficha; la de un proveedor nuevo, con el pais escrito.
  if (guardada?.emisor.direccion) l.emisor.direccion = guardada.emisor.direccion;
  if (paisNuevo) l.emisor.direccion = { valor: { ...(l.emisor.direccion?.valor ?? {}), pais: paisNuevo }, confianza: null, fuente: 'claude' };
  l.emisor.nif = { valor: nif, confianza: null, fuente: 'claude' };
  // El nombre sirve a V09 cuando la empresa no tiene NIF (se compara por nombre).
  l.emisor.nombre = { valor: nombre, confianza: null, fuente: 'claude' };
  l.receptor.nif = guardada?.receptor.nif ?? l.receptor.nif;
  l.receptor.nombre = guardada?.receptor.nombre ?? l.receptor.nombre;
  l.numero = { valor: typeof cuerpo.numeroFacturaProveedor === 'string' ? cuerpo.numeroFacturaProveedor : null, confianza: null, fuente: 'claude' };
  l.fechaEmision = { valor: typeof cuerpo.fechaEmision === 'string' ? cuerpo.fechaEmision : null, confianza: null, fuente: 'claude' };
  const tipos = new Set<number>();
  for (const linea of Array.isArray(cuerpo.lineas) ? (cuerpo.lineas as Array<{ tipoIva?: unknown }>) : []) {
    if (typeof linea.tipoIva === 'number') tipos.add(linea.tipoIva);
  }
  l.desglose = [...tipos].map((tipoIva) => ({ tipoIva, base: { valor: 0, confianza: null, fuente: 'claude' }, cuota: { valor: 0, confianza: null, fuente: 'claude' }, tipoRecargo: null, cuotaRecargo: null }));
  return { lectura: l, paisProveedor };
}

/**
 * Antes de registrar un gasto leido. Devuelve la fila de la lectura (para el
 * prefijo de observaciones).
 */
export async function comprobarLecturaParaConfirmar(companyId: string, lecturaId: string, lector: Lector, cuerpo: Record<string, unknown>): Promise<FilaLectura> {
  const fila = await prisma.lecturaDocumento.findFirst({ where: { id: lecturaId, companyId, lector } });
  if (!fila) throw notFound(MENSAJE_LECTURA_NO_ENCONTRADA);
  if (fila.estado === 'CONFIRMADA') throw conflict('Esta factura ya se registró.', { codigo: 'LECTURA_YA_CONFIRMADA' });
  if (fila.estado !== 'LISTA') throw badRequest('Esta lectura ya no se puede registrar: está descartada o no ha terminado. Vuelve a leer la factura.', { codigo: 'LECTURA_NO_LISTA' });
  if (necesitaRevision(fila) && cuerpo.revisado !== true) throw badRequest(MENSAJE_FALTA_REVISION, { codigo: 'FALTA_REVISION' });
  // Una rectificativa o un abono (V19) se registra como abono: hace falta decir que rectifica
  // (bloque `rectificativa`) o marcar que no lo es (noEsRectificativa, que queda en AuditLog).
  if (lector === 'GASTO' && esLecturaRectificativa(fila) && (cuerpo.rectificativa === undefined || cuerpo.rectificativa === null) && cuerpo.noEsRectificativa !== true) {
    throw badRequest(MENSAJE_FALTA_RECTIFICATIVA, { codigo: 'FALTA_RECTIFICATIVA', campo: 'rectificativa' });
  }

  const guardada = ((fila.resultado as { lectura?: LecturaNormalizada } | null)?.lectura ?? null) as LecturaNormalizada | null;
  const { lectura: l, paisProveedor } = await lecturaDelCuerpo(companyId, cuerpo, guardada);
  const [empresa, perfil] = await Promise.all([datosEmpresaValidacion(companyId), perfilEmpresa(companyId)]);
  const errores = validacionesSincronas(l, {
    lector,
    nifEmpresa: empresa.nifEmpresa,
    nombresEmpresa: empresa.nombresEmpresa,
    empresaEspanola: perfil.espanola,
    monedaCuenta: perfil.monedaCuenta,
    hoy: hoyEspana(),
    periodoAbierto: async () => true,
    duplicado: { factura: null, archivo: null },
    // De donde dijo la persona que es el proveedor (manda) y el pais de su ficha.
    origenTercero: eleccionGuardada(fila.resultado),
    paisTerceroFicha: paisProveedor,
  }).filter((v) => REVALIDAR_GASTO.has(v.codigo) && v.nivel === 'error');
  if (errores.length) {
    throw badRequest(errores[0].mensaje, { codigo: 'VALIDACION_LECTURA', campo: errores[0].campos[0] ?? null, validaciones: errores });
  }
  return fila;
}

/**
 * Antes de registrar una venta leida: si la lectura tenia algo marcado, hace
 * falta "He revisado"; y lo que la lectura dejo en error sigue bloqueando,
 * aunque el documento se haya corregido despues por PUT /invoice-extractor/:id
 * (que rehace validation.errors con las validaciones antiguas).
 *
 * `ignorar`: codigos de validacion que ya no aplican (p. ej. NIF_RECEPTOR
 * cuando se ha elegido un cliente dado de alta). Devuelve los mensajes de las
 * validaciones ignoradas, para quitarlos tambien de los errores del documento,
 * y si el documento viene de una lectura (/lecturas).
 *
 * Rectificativas (V19, codigo RECTIFICATIVA): hay que decir que rectifica (el
 * bloque `rectificativa`) o marcar que no lo es (`noEsRectificativa`); si no,
 * 400 FALTA_RECTIFICATIVA. Con cualquiera de las dos, la V19 guardada en
 * error por una lectura de antes (cuando aun no se podian registrar) ya no bloquea.
 */
export async function comprobarRevisionVenta(
  companyId: string,
  incomeReaderDocumentId: string,
  revisado: boolean,
  ignorar: string[] = [],
  rect: { bloque: boolean; noEsRectificativa: boolean } = { bloque: false, noEsRectificativa: false },
): Promise<{ ignoradas: string[]; deLectura: boolean }> {
  const fila = await prisma.lecturaDocumento.findFirst({
    where: { companyId, incomeReaderDocumentId, lector: 'VENTA' },
    select: { estado: true, estadoValidacion: true, validaciones: true, origen: true },
  });
  if (!fila) return { ignoradas: [], deLectura: false }; // Documento del lector de siempre (/extraer-ia): como hoy.
  if (fila.estado === 'CONFIRMADA') throw conflict('Esta factura ya se registró.', { codigo: 'LECTURA_YA_CONFIRMADA' });
  // Rellenada a mano: sin nada leido, hacen falta los datos (el bloque `correcciones`).
  if (fila.origen === 'MANUAL') throw badRequest(MENSAJE_FALTA_CORRECCIONES, { codigo: 'FALTA_CORRECCIONES', campo: 'correcciones' });
  if (necesitaRevision(fila) && !revisado) throw badRequest(MENSAJE_FALTA_REVISION, { codigo: 'FALTA_REVISION' });
  if (esLecturaRectificativa(fila)) {
    if (!rect.bloque && !rect.noEsRectificativa) throw badRequest(MENSAJE_FALTA_RECTIFICATIVA, { codigo: 'FALTA_RECTIFICATIVA', campo: 'rectificativa' });
    ignorar = [...ignorar, 'RECTIFICATIVA'];
  }
  const ignoradas = validacionesGuardadas(fila).filter((v) => ignorar.includes(v.codigo));
  const errores = validacionesGuardadas(fila).filter((v) => v.nivel === 'error' && !ignorar.includes(v.codigo));
  if (errores.length) {
    throw badRequest(`No se puede registrar: ${[...new Set(errores.map((v) => v.mensaje))].join(' ')}`, { codigo: 'VALIDACION_LECTURA', validaciones: errores });
  }
  return { ignoradas: ignoradas.map((v) => v.mensaje), deLectura: true };
}

export const MENSAJE_CORRECCIONES_SIN_LECTURA =
  'Esta factura se leyó con el lector antiguo y sus datos no se pueden corregir aquí. Vuelve a leerla o créala en Ventas → Nueva factura.';
export const MENSAJE_FALTA_CORRECCIONES = 'Esta factura no se ha leído: escribe el número, la fecha, las líneas y el total antes de registrarla.';

/** Lo que deja comprobado comprobarCorreccionVenta para registrar la venta corregida. */
export interface CorreccionComprobada {
  correcciones: CorreccionesVenta;
  /** La lectura guardada con lo corregido (y el QR cotejado otra vez). */
  lectura: LecturaNormalizada;
  /** Las validaciones de la lectura corregida que no se han dado por buenas. */
  validaciones: ResultadoValidacion[];
  /** Mensajes de las validaciones que ya no aplican (NIF del cliente con uno elegido, la rectificativa con su bloque). */
  ignoradas: string[];
  /** La lectura se rellena a mano («Rellenarla a mano»): no habia nada leido. */
  manual: boolean;
  /** Lo leido antes de corregir, para el AuditLog (null si se rellena a mano). */
  leida: LecturaNormalizada | null;
  lecturaId: string;
  confianza: number | null;
}

/** Lo que falta en una lectura rellenada a mano, en el orden de la pantalla. */
const OBLIGATORIOS_A_MANO: Array<keyof CorreccionesVenta> = ['numero', 'fechaEmision', 'lineas', 'total'];

/**
 * Antes de registrar una venta leida CON correcciones (el bloque
 * `correcciones` de /ingresos-extractor/confirmar). null si no llega ninguna
 * (se sigue con comprobarRevisionVenta, como hoy).
 *
 * Se arma la lectura corregida (lo guardado al leer mas lo corregido) y se
 * vuelve a validar con las mismas reglas que una lectura, con el contexto de
 * ahora: duplicado con el numero corregido, periodo, de donde es el cliente y
 * el QR otra vez. Los errores que ya no aplican dejan de bloquear y los que
 * siguen dan 400 VALIDACION_LECTURA con el campo de la correccion. «He
 * revisado» hace falta si la lectura tenia algo marcado o si la nueva
 * validacion deja algo para revisar (en una rellenada a mano, solo esto
 * ultimo): si no, 400 FALTA_REVISION con lo que queda.
 */
export async function comprobarCorreccionVenta(
  companyId: string,
  incomeReaderDocumentId: string,
  raw: unknown,
  opciones: { revisado: boolean; ignorar: string[]; rect: { bloque: boolean; noEsRectificativa: boolean }; negativosLeidos: boolean },
): Promise<CorreccionComprobada | null> {
  if (raw === undefined || raw === null) return null;
  const fila = await prisma.lecturaDocumento.findFirst({ where: { companyId, incomeReaderDocumentId, lector: 'VENTA' } });
  const guardada = ((fila?.resultado as { lectura?: LecturaNormalizada } | null)?.lectura ?? null) as LecturaNormalizada | null;
  if (!fila) throw badRequest(MENSAJE_CORRECCIONES_SIN_LECTURA, { codigo: 'CORRECCIONES_SIN_LECTURA', campo: 'correcciones' });
  if (fila.estado === 'CONFIRMADA') throw conflict('Esta factura ya se registró.', { codigo: 'LECTURA_YA_CONFIRMADA' });
  if (fila.estado !== 'LISTA') throw badRequest('Esta lectura ya no se puede registrar: está descartada o no ha terminado. Vuelve a leer la factura.', { codigo: 'LECTURA_NO_LISTA' });
  if (!guardada) throw badRequest(MENSAJE_CORRECCIONES_SIN_LECTURA, { codigo: 'CORRECCIONES_SIN_LECTURA', campo: 'correcciones' });

  const perfil = await perfilEmpresa(companyId);
  const c = leerCorrecciones(raw, { espanola: perfil.espanola, rectificativa: esLecturaRectificativa(fila) || opciones.negativosLeidos });
  if (!c) return null;
  const manual = fila.origen === 'MANUAL';
  if (manual) {
    const falta = OBLIGATORIOS_A_MANO.find((k) => c[k] === undefined || c[k] === null);
    if (falta) throw badRequest(MENSAJE_FALTA_CORRECCIONES, { codigo: 'FALTA_CORRECCIONES', campo: `correcciones.${falta}` });
  }

  const lc = aplicarCorrecciones(guardada, c);
  const ctx = await contextoValidacion(companyId, 'VENTA', lc, { archivoHash: fila.archivoHash, lecturaId: fila.id, origenTercero: eleccionGuardada(fila.resultado) });
  const val = await validarLectura(lc, ctx);
  const ignorar = new Set(opciones.ignorar);
  // Rectificativa o abono (V19 sobre lo corregido): su bloque o «no es una rectificativa».
  if (val.validaciones.some((v) => v.codigo === 'RECTIFICATIVA')) {
    if (!opciones.rect.bloque && !opciones.rect.noEsRectificativa) throw badRequest(MENSAJE_FALTA_RECTIFICATIVA, { codigo: 'FALTA_RECTIFICATIVA', campo: 'rectificativa' });
    ignorar.add('RECTIFICATIVA');
  }
  const errores = val.validaciones.filter((v) => v.nivel === 'error' && !ignorar.has(v.codigo));
  if (errores.length) {
    throw badRequest(`No se puede registrar: ${[...new Set(errores.map((v) => v.mensaje))].join(' ')}`, {
      codigo: 'VALIDACION_LECTURA',
      campo: campoDeCorreccion(errores[0].campos[0], c, lc, errores[0].codigo),
      validaciones: errores,
    });
  }
  // Lo que queda para revisar: validaciones y datos leidos con poca seguridad que no se han corregido.
  const pendientes: ResultadoValidacion[] = [
    ...val.validaciones.filter((v) => v.nivel === 'revisar' && !ignorar.has(v.codigo)),
    ...camposDeLectura(lc).flatMap(([id, campo]) => {
      const { nivel, motivo } = estadoPorConfianza(campo);
      return nivel === 'ok' || (id.startsWith('receptor.') && ignorar.has('NIF_RECEPTOR')) ? [] : [{ codigo: 'CONFIANZA', nivel, campos: [id], mensaje: motivo ?? 'Compruébalo.' }];
    }),
  ];
  if (((!manual && necesitaRevision(fila)) || pendientes.length) && !opciones.revisado) {
    throw badRequest(MENSAJE_FALTA_REVISION, { codigo: 'FALTA_REVISION', validaciones: pendientes });
  }
  return {
    correcciones: c,
    lectura: lc,
    validaciones: val.validaciones.filter((v) => !ignorar.has(v.codigo)),
    ignoradas: val.validaciones.filter((v) => ignorar.has(v.codigo)).map((v) => v.mensaje),
    manual,
    leida: manual ? null : guardada,
    lecturaId: fila.id,
    confianza: fila.confianza,
  };
}

/** Tras registrar: la lectura queda CONFIRMADA. Nunca rompe el alta (lo que falle va al log). */
export async function vincularLectura(
  companyId: string,
  donde: { lecturaId?: string; incomeReaderDocumentId?: string },
  datos: { expenseInvoiceId?: string; incomeInvoiceId?: string; userId?: string | null; revisada: boolean },
): Promise<void> {
  const fila = await prisma.lecturaDocumento.findFirst({
    where: { companyId, estado: 'LISTA', ...(donde.lecturaId ? { id: donde.lecturaId } : { incomeReaderDocumentId: donde.incomeReaderDocumentId ?? '-' }) },
  });
  if (!fila) return;
  const hecho = await prisma.lecturaDocumento.updateMany({
    where: { id: fila.id, estado: 'LISTA' },
    data: {
      estado: 'CONFIRMADA',
      confirmadaPor: datos.userId ?? null,
      confirmadaEn: new Date(),
      revisada: datos.revisada,
      expenseInvoiceId: datos.expenseInvoiceId ?? null,
      incomeInvoiceId: datos.incomeInvoiceId ?? null,
    },
  });
  if (hecho.count === 0 || !fila.archivoRef) return;

  try {
    if (fila.lector === 'GASTO' && datos.expenseInvoiceId) {
      // El original se guarda con la factura (hoy se archivaba "sin original").
      const buffer = await getObject(fila.archivoRef);
      await archivarGastoSinRomper(companyId, datos.expenseInvoiceId, { buffer, nombre: fila.archivoNombre, mime: fila.archivoTipo });
    } else if (fila.lector === 'VENTA' && fila.incomeReaderDocumentId) {
      // El documento del lector movio el archivo a su carpeta; si no pudo, se deja.
      const doc = await prisma.incomeReaderDocument.findUnique({ where: { id: fila.incomeReaderDocumentId }, select: { storagePath: true } });
      if (doc?.storagePath === fila.archivoRef) return;
    }
    await deleteObject(fila.archivoRef);
    await prisma.lecturaDocumento.update({ where: { id: fila.id }, data: { archivoRef: null } });
  } catch (err) {
    logger.warn('[lectura] No se ha podido archivar o borrar el archivo de la lectura', { lecturaId: fila.id, error: (err as { name?: string })?.name ?? 'Error' });
  }
}
