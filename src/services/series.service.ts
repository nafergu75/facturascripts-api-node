import { Prisma, type InvoiceSeries } from '@prisma/client';
import { prisma, type TransaccionBD as Tx } from '../config/database';
import { SerieDocumento, TipoDocumentoSerie, TIPOS_DOCUMENTO_SERIE, esTipoDocumentoSerie } from '../domain/series.model';
import { badRequest, conflict, notFound } from '../utils/http-errors';

/**
 * Series de documentos por empresa, guardadas en la tabla InvoiceSeries.
 * Cada serie lleva su ultimo numero emitido: la numeracion de las facturas
 * finales sale de aqui, en orden y sin huecos (ver siguienteNumero).
 *
 * Reglas que se mantienen siempre:
 *  - la serie predeterminada de cada tipo esta activa;
 *  - las facturas y las rectificativas tienen al menos una serie activa;
 *  - una serie no se crea sola por teclear un codigo: solo las del lector o
 *    de una importacion (con su numero original), y desactivadas.
 */

/** Tipos que siempre necesitan una serie activa (las proformas no son facturas). */
const TIPOS_CON_SERIE_OBLIGATORIA: readonly TipoDocumentoSerie[] = ['FACTURA', 'RECTIFICATIVA'];

const NOMBRE_TIPO: Record<TipoDocumentoSerie, string> = {
  FACTURA: 'facturas',
  RECTIFICATIVA: 'rectificativas',
  RECTIFICATIVA_SIMPLIFICADA: 'rectificativas de tickets',
  PROFORMA: 'proformas',
};

const CODIGO_RE = /^[A-Z0-9-]{1,10}$/;

/** Mayor numero inicial que se admite (la columna es un entero de 32 bits). */
export const NUMERO_INICIAL_MAX = 999_999_999;

/**
 * Numero inicial de una serie (para seguir la numeracion de otro programa):
 * entero desde 1. undefined si no se indica.
 */
function validarNumeroInicial(valor: unknown): number | undefined {
  if (valor === undefined || valor === null || valor === '') return undefined;
  const n = typeof valor === 'number' ? valor : Number(valor);
  if (!Number.isInteger(n) || n < 1 || n > NUMERO_INICIAL_MAX) {
    throw badRequest('El número inicial es un número entero desde 1 (sin letras ni decimales).', { campo: 'numeroInicial' });
  }
  return n;
}

/** Documentos ya numerados en la serie (los borradores aun no tienen numero). */
function contarDocumentos(db: Tx | typeof prisma, companyId: string, codigo: string): Promise<number> {
  return db.incomeInvoice.count({ where: { companyId, serie: codigo, numero: { not: null } } });
}

function aDominio(s: InvoiceSeries): SerieDocumento {
  return {
    id: s.id,
    companyId: s.companyId,
    codigo: s.codigo,
    descripcion: s.descripcion,
    tipoDocumento: s.tipoDocumento as TipoDocumentoSerie,
    activa: s.activa,
    porDefecto: s.porDefecto,
    ultimoNumero: s.ultimoNumero,
    ultimaFecha: s.ultimaFecha ?? undefined,
    creadoEn: s.createdAt.toISOString(),
    actualizadoEn: s.updatedAt.toISOString(),
  };
}

/**
 * Series que toda empresa necesita: la general de facturas, la de rectificativas
 * y la de facturas proforma (P-1, P-2...; no son facturas, no cuentan para nada fiscal).
 * Si el codigo ya lo usa otra serie de otro tipo, se prueba con el alternativo.
 */
const SEMILLAS: Array<Pick<SerieDocumento, 'codigo' | 'descripcion' | 'tipoDocumento'> & { alternativo?: string }> = [
  { codigo: 'A', descripcion: 'Serie general', tipoDocumento: 'FACTURA' },
  { codigo: 'R', descripcion: 'Facturas rectificativas', tipoDocumento: 'RECTIFICATIVA' },
  { codigo: 'P', descripcion: 'Facturas proforma', tipoDocumento: 'PROFORMA', alternativo: 'PF' },
];

/** Crea las series por defecto que le falten a la empresa (idempotente). */
async function asegurarSemilla(companyId: string): Promise<void> {
  const existentes = await prisma.invoiceSeries.findMany({ where: { companyId }, select: { tipoDocumento: true } });
  const tipos = new Set(existentes.map((s) => s.tipoDocumento));
  for (const { alternativo, ...semilla } of SEMILLAS) {
    if (tipos.has(semilla.tipoDocumento)) continue;
    // upsert: dos peticiones a la vez no deben chocar con el unico (empresa, codigo).
    const s = await prisma.invoiceSeries.upsert({
      where: { companyId_codigo: { companyId, codigo: semilla.codigo } },
      create: { companyId, ...semilla, activa: true, porDefecto: true },
      update: {},
    });
    if (s.tipoDocumento !== semilla.tipoDocumento && alternativo) {
      await prisma.invoiceSeries.upsert({
        where: { companyId_codigo: { companyId, codigo: alternativo } },
        create: { companyId, ...semilla, codigo: alternativo, activa: true, porDefecto: true },
        update: {},
      });
    }
  }
}

/**
 * Lista para la pantalla (GET /series): cada serie con el proximo numero y
 * cuantos documentos numerados tiene (el numero inicial solo se cambia sin ellos).
 */
export async function listarSeriesConUso(companyId: string, tipoDocumento?: TipoDocumentoSerie): Promise<SerieDocumento[]> {
  const series = await listarSeries(companyId, tipoDocumento);
  const usos = await prisma.incomeInvoice.groupBy({
    by: ['serie'],
    where: { companyId, numero: { not: null }, serie: { in: series.map((s) => s.codigo) } },
    _count: { _all: true },
  });
  const porSerie = new Map(usos.map((u) => [u.serie, u._count._all]));
  return series.map((s) => ({ ...s, numeroSiguiente: (s.ultimoNumero ?? 0) + 1, documentos: porSerie.get(s.codigo) ?? 0 }));
}

export async function listarSeries(companyId: string, tipoDocumento?: TipoDocumentoSerie): Promise<SerieDocumento[]> {
  await asegurarSemilla(companyId);
  const series = await prisma.invoiceSeries.findMany({
    where: { companyId, ...(tipoDocumento ? { tipoDocumento } : {}) },
    orderBy: [{ tipoDocumento: 'asc' }, { codigo: 'asc' }],
  });
  return series.map(aDominio);
}

/** Si una serie pasa a ser la por defecto, el resto del mismo tipo deja de serlo. */
async function desmarcarOtrasPorDefecto(db: Tx | typeof prisma, companyId: string, tipoDocumento: string, exceptoId?: string): Promise<void> {
  await db.invoiceSeries.updateMany({
    where: { companyId, tipoDocumento, porDefecto: true, ...(exceptoId ? { NOT: { id: exceptoId } } : {}) },
    data: { porDefecto: false },
  });
}

const esP2002 = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';

export async function crearSerie(
  companyId: string,
  data: Pick<SerieDocumento, 'codigo' | 'descripcion' | 'tipoDocumento' | 'activa' | 'porDefecto'> & { numeroInicial?: unknown },
): Promise<SerieDocumento> {
  const codigo = data.codigo?.trim().toUpperCase();
  if (!codigo) throw badRequest('El código de la serie es obligatorio.', { campo: 'codigo' });
  if (!CODIGO_RE.test(codigo)) {
    throw badRequest('El código de la serie solo admite letras sin acentos ni ñ, números y guiones (máximo 10).', { campo: 'codigo' });
  }
  if (!esTipoDocumentoSerie(data.tipoDocumento)) {
    throw badRequest(`Tipo de documento no válido. Usa: ${TIPOS_DOCUMENTO_SERIE.join(', ')}.`, { campo: 'tipoDocumento' });
  }
  const activa = data.activa ?? true;
  const porDefecto = data.porDefecto ?? false;
  if (typeof activa !== 'boolean' || typeof porDefecto !== 'boolean') throw badRequest('activa y porDefecto son sí o no (true/false).');
  if (porDefecto && !activa) {
    throw badRequest('Una serie desactivada no puede ser la predeterminada: créala activa.', { campo: 'porDefecto' });
  }
  // Numero inicial: el primer documento de la serie llevara ese numero.
  const numeroInicial = validarNumeroInicial(data.numeroInicial);
  const dup = await prisma.invoiceSeries.findUnique({ where: { companyId_codigo: { companyId, codigo } } });
  if (dup) throw conflict(`Ya existe la serie ${codigo}.`, { campo: 'codigo' });

  if (porDefecto) await desmarcarOtrasPorDefecto(prisma, companyId, data.tipoDocumento);
  try {
    const serie = await prisma.invoiceSeries.create({
      data: {
        companyId,
        codigo,
        descripcion: String(data.descripcion ?? ''),
        tipoDocumento: data.tipoDocumento,
        activa,
        porDefecto,
        ...(numeroInicial ? { ultimoNumero: numeroInicial - 1 } : {}),
      },
    });
    return aDominio(serie);
  } catch (e) {
    if (esP2002(e)) throw conflict(`Ya existe la serie ${codigo}.`, { campo: 'codigo' });
    throw e;
  }
}

/**
 * Cambia la descripcion, si esta activa, si es la predeterminada y el numero
 * inicial (solo mientras la serie no tiene documentos numerados: sirve para
 * seguir la numeracion de otro programa). El codigo y el tipo no se tocan:
 * cambiarlos romperia la correlatividad de las facturas ya emitidas. Las
 * reglas se comprueban dentro de una transaccion, con las series del mismo
 * tipo bloqueadas: dos cambios a la vez no pueden dejar un tipo sin serie
 * activa ni sin predeterminada.
 */
export async function actualizarSerie(
  companyId: string,
  serieId: string,
  data: Partial<Pick<SerieDocumento, 'descripcion' | 'activa' | 'porDefecto'>> & { numeroInicial?: unknown },
): Promise<SerieDocumento> {
  for (const campo of ['activa', 'porDefecto'] as const) {
    if (data[campo] !== undefined && typeof data[campo] !== 'boolean') {
      throw badRequest(`${campo} es sí o no (true/false).`, { campo });
    }
  }
  if (data.descripcion !== undefined && data.descripcion !== null && String(data.descripcion).length > 191) {
    throw badRequest('La descripción admite como máximo 191 caracteres.', { campo: 'descripcion' });
  }
  const numeroInicial = validarNumeroInicial(data.numeroInicial);
  const previa = await prisma.invoiceSeries.findFirst({ where: { id: serieId, companyId } });
  if (!previa) throw notFound('Serie no encontrada.');

  const serie = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM InvoiceSeries WHERE companyId = ${companyId} AND tipoDocumento = ${previa.tipoDocumento} FOR UPDATE`;
    const actual = await tx.invoiceSeries.findFirst({ where: { id: serieId, companyId } });
    if (!actual) throw notFound('Serie no encontrada.');
    const tipo = (esTipoDocumentoSerie(actual.tipoDocumento) ? NOMBRE_TIPO[actual.tipoDocumento] : actual.tipoDocumento.toLowerCase());
    const activa = data.activa ?? actual.activa;

    // (a) La predeterminada tiene que estar activa.
    if (data.porDefecto === true && !activa) {
      throw conflict(`La serie ${actual.codigo} está desactivada: actívala antes de marcarla como predeterminada.`, { campo: 'porDefecto' });
    }
    // (b) La predeterminada no se desactiva ni se desmarca sin mas: hay que elegir otra.
    if (actual.porDefecto && data.activa === false) {
      throw conflict(`La serie ${actual.codigo} es la predeterminada de ${tipo}. Marca antes otra serie como predeterminada.`, { campo: 'activa' });
    }
    if (actual.porDefecto && data.porDefecto === false) {
      throw conflict(`Para cambiar la serie predeterminada de ${tipo}, marca como predeterminada la otra serie: esta dejará de serlo sola.`, {
        campo: 'porDefecto',
      });
    }
    // (c) Facturas y rectificativas siempre con alguna serie activa.
    if (actual.activa && data.activa === false && (TIPOS_CON_SERIE_OBLIGATORIA as readonly string[]).includes(actual.tipoDocumento)) {
      const otrasActivas = await tx.invoiceSeries.count({
        where: { companyId, tipoDocumento: actual.tipoDocumento, activa: true, NOT: { id: actual.id } },
      });
      if (otrasActivas === 0) {
        throw conflict(`No puede quedar ninguna serie de ${tipo} activa: crea o activa otra antes de desactivar la ${actual.codigo}.`, { campo: 'activa' });
      }
    }

    // (d) El numero inicial solo mientras no haya documentos numerados en la serie.
    if (numeroInicial !== undefined && (await contarDocumentos(tx, companyId, actual.codigo)) > 0) {
      throw conflict(
        `La serie ${actual.codigo} ya tiene documentos numerados: su numeración sigue desde el último y el número inicial ya no se puede cambiar.`,
        { campo: 'numeroInicial' },
      );
    }

    if (data.porDefecto === true) await desmarcarOtrasPorDefecto(tx, companyId, actual.tipoDocumento, actual.id);
    return tx.invoiceSeries.update({
      where: { id: serieId },
      data: {
        ...(numeroInicial !== undefined ? { ultimoNumero: numeroInicial - 1, ultimaFecha: null } : {}),
        ...(data.descripcion !== undefined ? { descripcion: String(data.descripcion ?? '') } : {}),
        ...(data.activa !== undefined ? { activa: data.activa } : {}),
        ...(data.porDefecto !== undefined ? { porDefecto: data.porDefecto } : {}),
      },
    });
  });
  return aDominio(serie);
}

export async function obtenerSeriePorDefecto(
  companyId: string,
  tipoDocumento: TipoDocumentoSerie,
): Promise<SerieDocumento | null> {
  const series = (await listarSeries(companyId, tipoDocumento)).filter((s) => s.activa);
  return series.find((s) => s.porDefecto) ?? series[0] ?? null;
}

/** Codigos que se prueban, en orden, para la serie de rectificativas de tickets. */
const CODIGOS_TICKETS = ['RT', 'RTK'];

/** Codigo que tendra la serie de rectificativas de tickets: la que ya existe o la que se crearia (RT o, si esta ocupada, RTK). */
export async function codigoSerieTickets(companyId: string): Promise<{ codigo: string; existe: boolean }> {
  const def = await obtenerSeriePorDefecto(companyId, 'RECTIFICATIVA_SIMPLIFICADA');
  if (def) return { codigo: def.codigo, existe: true };
  const ocupados = new Set((await prisma.invoiceSeries.findMany({ where: { companyId, codigo: { in: CODIGOS_TICKETS } }, select: { codigo: true } })).map((s) => s.codigo));
  return { codigo: CODIGOS_TICKETS.find((c) => !ocupados.has(c)) ?? CODIGOS_TICKETS[0], existe: false };
}

/**
 * Serie de las rectificativas de tickets (R5): la predeterminada de su tipo o,
 * la primera vez que se guarda una R5, la RT (o RTK si RT ya es otra serie),
 * activa y predeterminada. La ley pide que vayan aparte de la R (art. 7.1.a RD
 * 1619/2012). Si la empresa ya tiene series de este tipo pero todas
 * desactivadas, 400 SERIE_TICKETS_DESACTIVADA: no se crea otra a sus espaldas.
 */
export async function obtenerOCrearSerieTickets(companyId: string): Promise<SerieDocumento> {
  const def = await obtenerSeriePorDefecto(companyId, 'RECTIFICATIVA_SIMPLIFICADA');
  if (def) return def;
  const existentes = await prisma.invoiceSeries.count({ where: { companyId, tipoDocumento: 'RECTIFICATIVA_SIMPLIFICADA' } });
  if (existentes > 0) {
    throw badRequest('Las series de rectificativas de tickets están desactivadas. Activa una en Configuración > Series para rectificar tickets.', {
      codigo: 'SERIE_TICKETS_DESACTIVADA',
      campo: 'serie',
    });
  }
  for (const codigo of CODIGOS_TICKETS) {
    // upsert: dos R5 a la vez no chocan con el unico (empresa, codigo).
    const s = await prisma.invoiceSeries.upsert({
      where: { companyId_codigo: { companyId, codigo } },
      create: { companyId, codigo, descripcion: 'Rectificativas de tickets', tipoDocumento: 'RECTIFICATIVA_SIMPLIFICADA', activa: true, porDefecto: true },
      update: {},
    });
    if (s.tipoDocumento === 'RECTIFICATIVA_SIMPLIFICADA') return aDominio(s);
  }
  throw conflict('Las series RT y RTK ya existen y son de otro tipo: crea en Configuración > Series una serie de rectificativas de tickets.', {
    codigo: 'SERIE_TICKETS_OCUPADA',
    campo: 'serie',
  });
}

/**
 * Resuelve la serie a usar al crear una factura a partir del DTO:
 *  - serieId     -> esa serie (de la empresa y de tipo FACTURA)
 *  - serieCodigo -> busca por codigo
 *  - si nada     -> serie por defecto de FACTURA
 * Devuelve el codigo de la serie.
 */
export async function resolverCodSerieFactura(
  companyId: string,
  dto: { serieId?: string; serieCodigo?: string },
): Promise<string> {
  if (dto.serieId) {
    const s = await prisma.invoiceSeries.findFirst({ where: { id: dto.serieId, companyId } });
    if (!s || s.tipoDocumento !== 'FACTURA') throw badRequest('serieId no valido para esta empresa.');
    return s.codigo;
  }
  if (dto.serieCodigo) {
    const series = await listarSeries(companyId, 'FACTURA');
    const s = series.find((x) => x.codigo === dto.serieCodigo);
    if (!s) throw badRequest(`serieCodigo '${dto.serieCodigo}' no existe para FACTURA.`);
    return s.codigo;
  }
  const def = await obtenerSeriePorDefecto(companyId, 'FACTURA');
  if (!def) throw badRequest('No hay serie por defecto de FACTURA configurada.');
  return def.codigo;
}

/**
 * Serie de la empresa por su codigo (tal cual o en mayusculas), o null. No crea
 * nada: una errata al teclear la serie ya no crea una serie nueva y activa.
 */
export async function buscarSeriePorCodigo(companyId: string, codigo: string): Promise<SerieDocumento | null> {
  await asegurarSemilla(companyId);
  const limpio = String(codigo ?? '').trim();
  if (!limpio) return null;
  const candidatos = [...new Set([limpio, limpio.toUpperCase()])];
  for (const c of candidatos) {
    const s = await prisma.invoiceSeries.findUnique({ where: { companyId_codigo: { companyId, codigo: c } } });
    if (s) return aDominio(s);
  }
  return null;
}

/**
 * Codigo de serie valido a partir del que trae una factura leida ("fac/2026"
 * -> "FAC-2026"): mayusculas, lo que no sea letra, numero o guion pasa a guion
 * y como mucho 10 caracteres. Vacio si no queda nada.
 */
export function normalizarCodigoSerie(texto: string): string {
  return String(texto ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 10)
    .replace(/-+$/, '');
}

/**
 * Caracteres que la AEAT no admite en NumSerieFactura (VERI*FACTU): solo ASCII
 * imprimible (32-126) y sin « " ' < > = ». La app prohibe ademas «&», porque
 * no esta claro como entra en la huella (spec verifactu, 3.5).
 */
const PROHIBIDOS_AEAT = /["'<>=&]/;
const ASCII_IMPRIMIBLE = /^[\x20-\x7E]+$/;

/**
 * null si el codigo de la serie sirve para el numero de factura que se envia a
 * la AEAT; si no, el aviso para la persona. Las series nuevas ya no pueden
 * llevar esos caracteres (CODIGO_RE), pero una antigua si: con ella no se emite.
 */
export function problemaSerieAeat(codigo: string): string | null {
  const c = String(codigo ?? '');
  if (ASCII_IMPRIMIBLE.test(c) && !PROHIBIDOS_AEAT.test(c) && c.trim().length > 0) return null;
  return (
    `La serie ${c} tiene caracteres que la AEAT no admite en el número de factura ` +
    '(acentos, ñ, comillas, &, <, > o =). Emite la factura en otra serie: solo letras sin acentos, números y guiones.'
  );
}

/**
 * Serie de una factura que llega del lector (o de una importacion) con su
 * numeracion original. Siempre es una serie HISTORICA (desactivada): guarda la
 * numeracion de otro programa, no sale para emitir facturas nuevas y su
 * contador no se mezcla con el de las series de la app (spec verifactu, P5).
 *
 *  - Si ya existe una serie desactivada con ese codigo, del mismo tipo y sin
 *    facturas emitidas por la app, se usa.
 *  - Si el codigo coincide con una serie de la app (activa, o desactivada pero
 *    con facturas que emitio la app, o de otro tipo), 409: el otro programa
 *    tiene que numerar en otra serie. Antes se guardaba en «<codigo>-H», pero
 *    asi la factura quedaba con un numero que no es el suyo (el libro de
 *    expedidas y el PDF decian «A-H-500» en vez de «A-500») y se escondia un
 *    choque real: dos facturas A-500 del mismo emisor (art. 6.1.a RD 1619/2012).
 *  - Si no existe, se crea desactivada con el codigo normalizado.
 *
 * Solo para ese camino: la pantalla y la API usan buscarSeriePorCodigo, y un
 * codigo que no existe es un 400.
 */
export async function obtenerOCrearSerieHistorica(
  companyId: string,
  codigoLeido: string,
  tipoDocumento: TipoDocumentoSerie = 'FACTURA',
  // Lector: una serie historica de OTRO tipo (el otro programa numera facturas
  // y rectificativas en la misma serie) se usa igual, y la respuesta lo dice
  // (`mixta`) para avisar. Con una serie de la app sigue siendo 409.
  opciones: { aceptarOtroTipo?: boolean } = {},
): Promise<SerieDocumento & { mixta?: boolean }> {
  const codigo = normalizarCodigoSerie(codigoLeido);
  if (!CODIGO_RE.test(codigo)) {
    throw badRequest(`La serie "${codigoLeido}" de la factura no es válida: corrígela (letras, números y guiones, máximo 10).`, { campo: 'serie' });
  }
  // Tal cual se leyo (o en mayusculas) y, si no, ya normalizado («fac/26» -> FAC-26).
  const existente = (await buscarSeriePorCodigo(companyId, codigoLeido)) ?? (await buscarSeriePorCodigo(companyId, codigo));
  if (existente) {
    const historica = !existente.activa && existente.tipoDocumento !== 'PROFORMA' && !(await tieneFacturasDeLaApp(companyId, existente.codigo));
    if (historica && existente.tipoDocumento === tipoDocumento) return existente;
    if (historica && opciones.aceptarOtroTipo) return { ...existente, mixta: true };
    throw choqueConSerieDeLaApp(existente.codigo);
  }

  const s = await prisma.invoiceSeries.upsert({
    where: { companyId_codigo: { companyId, codigo } },
    create: { companyId, codigo, descripcion: `Serie ${codigo} (facturas de otro programa)`, tipoDocumento, activa: false, porDefecto: false },
    update: {},
  });
  // Otra peticion pudo crearla a la vez como serie activa: no se mezcla.
  if (s.activa || s.tipoDocumento !== tipoDocumento) throw choqueConSerieDeLaApp(codigo);
  return aDominio(s);
}

/** ¿Hay en la serie alguna factura que no llegara del lector (la emitio la app)? */
async function tieneFacturasDeLaApp(companyId: string, serie: string): Promise<boolean> {
  const n = await prisma.incomeInvoice.count({
    where: {
      companyId,
      serie,
      // Las antiguas del lector no tienen origen, pero si su documento leido.
      readerDocument: { is: null },
      OR: [{ origen: null }, { origen: { not: 'lector' } }],
    },
  });
  return n > 0;
}

function choqueConSerieDeLaApp(codigo: string) {
  return conflict(
    `La serie ${codigo} es una de las series con las que la app emite facturas, y dos facturas no pueden tener el mismo número. ` +
      'Si la factura es de otro programa, ese programa tiene que numerar en una serie distinta. ' +
      'Si la serie se ha leído mal, corrígela antes de registrarla.',
    { campo: 'serie' },
  );
}
