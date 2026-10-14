/**
 * Series que se crean solas: las de toda empresa y la B de cerámica.
 *
 * Va aparte de series.service para que Configuración > Facturación
 * (ajustesFacturacion.service) pueda crear la B sin importar series.service,
 * que ya lee de allí los ajustes (sería una importación circular).
 *
 *  - A (facturas, predeterminada), R (rectificativas) y P (proformas; PF si P
 *    ya es otra serie): solo en el tipo que aún no tiene ninguna serie.
 *  - C (prestaciones de servicios): en todas las empresas, activa y no
 *    predeterminada, si ninguna serie usa ya el código C.
 *  - B (cerámica y materiales de construcción): solo si la empresa es española
 *    y tiene marcada «Vendo cerámica y materiales de construcción»
 *    (Configuración > Facturación). Activa, no predeterminada y sin plantilla
 *    elegida, así usa sola la plantilla B. Si el código B ya lo usa otra serie
 *    (desactivada, de otro tipo o con otra plantilla), no se toca: se avisa.
 *    Desmarcar la casilla no borra ni desactiva nada.
 *
 * Todo por (empresa, código) con upsert. En MySQL, el upsert de Prisma lee y
 * después inserta, así que dos peticiones a la vez pueden chocar con el único
 * (P2002): entonces se lee la fila que creó la otra (crearSiFalta). La B y la
 * C van siempre después de la A: en una empresa nueva la semilla solo crea la
 * A si no hay ninguna serie de facturas, y así la A sigue siendo la
 * predeterminada aunque lo primero que se haga sea marcar la casilla. Cada
 * serie lleva su propia numeración desde 1: la B no cambia la de la A.
 */
import type { InvoiceSeries, Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import type { TipoDocumentoSerie } from '../domain/series.model';
import { normalizarPlantillaId } from '../domain/plantillasFactura';
import { esClaveRepetida } from '../utils/reintento';

/**
 * Series que toda empresa necesita: la general de facturas, la de rectificativas
 * y la de facturas proforma (P-1, P-2...; no son facturas, no cuentan para nada fiscal).
 * Si el codigo ya lo usa otra serie de otro tipo, se prueba con el alternativo.
 */
const SEMILLAS: Array<{ codigo: string; descripcion: string; tipoDocumento: TipoDocumentoSerie; alternativo?: string }> = [
  { codigo: 'A', descripcion: 'Serie general', tipoDocumento: 'FACTURA' },
  { codigo: 'R', descripcion: 'Facturas rectificativas', tipoDocumento: 'RECTIFICATIVA' },
  { codigo: 'P', descripcion: 'Facturas proforma', tipoDocumento: 'PROFORMA', alternativo: 'PF' },
];

/**
 * Serie C de facturas (prestaciones de servicios; usa sola la plantilla C):
 * se crea en todas las empresas, las de antes y las nuevas, activa y sin ser
 * la predeterminada, si no hay ya una serie con el codigo C (de cualquier
 * tipo). Su numeracion es la suya, independiente de la A y la B.
 */
const SERIE_C = { codigo: 'C', descripcion: 'Prestaciones de servicios', tipoDocumento: 'FACTURA' } as const;

/** Serie B de facturas (cerámica; usa sola la plantilla B si la empresa vende cerámica). */
export const SERIE_B = { codigo: 'B', descripcion: 'Cerámica y materiales de construcción', tipoDocumento: 'FACTURA' } as const;

/**
 * La serie (empresa, código): la que ya hay o, si no hay ninguna, la de
 * `create`. Si otra petición la crea a la vez (en MySQL el upsert de Prisma
 * lee y después inserta: P2002), se devuelve la que creó la otra.
 */
async function crearSiFalta(companyId: string, codigo: string, create: Prisma.InvoiceSeriesUncheckedCreateInput): Promise<InvoiceSeries> {
  const where = { companyId_codigo: { companyId, codigo } };
  try {
    return await prisma.invoiceSeries.upsert({ where, create, update: {} });
  } catch (err) {
    if (!esClaveRepetida(err)) throw err;
    const ya = await prisma.invoiceSeries.findUnique({ where });
    if (!ya) throw err;
    return ya;
  }
}

/**
 * Crea las series que le falten a la empresa (idempotente). `conSerieB` solo
 * se consulta si ninguna serie usa el código B: dice si la empresa es española
 * y vende cerámica. Devuelve si se ha creado la B en esta llamada (o a la vez
 * en otra: las dos lo dicen).
 */
export async function sembrarSeries(companyId: string, conSerieB: () => Promise<boolean>): Promise<{ serieBCreada: boolean }> {
  const existentes = await prisma.invoiceSeries.findMany({ where: { companyId }, select: { tipoDocumento: true, codigo: true } });
  const tipos = new Set(existentes.map((s) => s.tipoDocumento));
  // La C y la B, despues de las de siempre: en una empresa nueva, la A se crea igual (y es la predeterminada).
  const sinSerieC = !existentes.some((s) => s.codigo === SERIE_C.codigo);
  const sinSerieB = !existentes.some((s) => s.codigo === SERIE_B.codigo);
  for (const { alternativo, ...semilla } of SEMILLAS) {
    if (tipos.has(semilla.tipoDocumento)) continue;
    const s = await crearSiFalta(companyId, semilla.codigo, { companyId, ...semilla, activa: true, porDefecto: true });
    if (s.tipoDocumento !== semilla.tipoDocumento && alternativo) {
      await crearSiFalta(companyId, alternativo, { companyId, ...semilla, codigo: alternativo, activa: true, porDefecto: true });
    }
  }
  if (sinSerieC) {
    await crearSiFalta(companyId, SERIE_C.codigo, { companyId, ...SERIE_C, activa: true, porDefecto: false });
  }
  if (sinSerieB && (await conSerieB())) {
    // Sin plantilla elegida: usa la B automatica mientras la casilla siga marcada.
    const b = await crearSiFalta(companyId, SERIE_B.codigo, { companyId, ...SERIE_B, activa: true, porDefecto: false });
    return { serieBCreada: b.tipoDocumento === SERIE_B.tipoDocumento && b.activa && !b.plantilla };
  }
  return { serieBCreada: false };
}

/**
 * Cómo está la serie B de una empresa que vende cerámica:
 *  - 'creada': se acaba de crear al guardar Configuración > Facturación;
 *  - 'activa': ya existía, activa y con la plantilla B;
 *  - 'pendiente': aún no existe (se crea al guardar la casilla o al abrir las series);
 *  - 'desactivada': existe pero está desactivada (no se activa sola);
 *  - 'otroTipo': el código B lo usa una serie de rectificativas o de proformas;
 *  - 'otraPlantilla': es de facturas y activa, pero tiene elegida otra plantilla.
 * `aviso`: lo que la persona tiene que hacer (null si nada).
 */
export type EstadoSerieCeramica = 'creada' | 'activa' | 'pendiente' | 'desactivada' | 'otroTipo' | 'otraPlantilla';

export interface SerieCeramica {
  codigo: string;
  estado: EstadoSerieCeramica;
  aviso: string | null;
}

const NOMBRE_TIPO: Record<string, string> = {
  RECTIFICATIVA: 'rectificativas',
  RECTIFICATIVA_SIMPLIFICADA: 'rectificativas de tickets',
  PROFORMA: 'proformas',
};

const NOMBRE_PLANTILLA: Record<string, string> = { default: 'Estándar', A: 'Plantilla A (envases)', B: 'Plantilla B (cerámica)', C: 'Plantilla C (servicios)' };

type FilaSerieB = { tipoDocumento: string; activa: boolean; plantilla: string | null } | null;

function describir(fila: FilaSerieB, creada: boolean): SerieCeramica {
  const codigo = SERIE_B.codigo;
  if (!fila) return { codigo, estado: 'pendiente', aviso: null };
  if (fila.tipoDocumento !== SERIE_B.tipoDocumento) {
    const tipo = NOMBRE_TIPO[fila.tipoDocumento] ?? fila.tipoDocumento.toLowerCase();
    return {
      codigo,
      estado: 'otroTipo',
      aviso:
        `El código B ya lo usa tu serie de ${tipo}, así que no se ha creado la serie B de facturas. ` +
        'Para facturar cerámica, crea en Configuración > Series una serie de facturas con otro código y elige en ella la «Plantilla B (cerámica)».',
    };
  }
  if (!fila.activa) {
    return {
      codigo,
      estado: 'desactivada',
      aviso: 'La serie B está desactivada. Para hacer facturas de cerámica con la plantilla B, actívala en Configuración > Series.',
    };
  }
  const elegida = fila.plantilla ? normalizarPlantillaId(fila.plantilla) : null;
  if (elegida && elegida !== 'B') {
    return {
      codigo,
      estado: 'otraPlantilla',
      aviso:
        `La serie B tiene elegida la ${NOMBRE_PLANTILLA[elegida] ?? elegida} en Configuración > Series. ` +
        'Para que sus facturas salgan con las columnas de cerámica, pon allí la plantilla «Automática» o la «Plantilla B (cerámica)».',
    };
  }
  return { codigo, estado: creada ? 'creada' : 'activa', aviso: null };
}

async function leerSerieB(companyId: string): Promise<FilaSerieB> {
  return prisma.invoiceSeries.findUnique({
    where: { companyId_codigo: { companyId, codigo: SERIE_B.codigo } },
    select: { tipoDocumento: true, activa: true, plantilla: true },
  });
}

/** Cómo está la serie B, sin crear nada (GET de Configuración > Facturación). Sin la tabla (prisma simulado), null. */
export async function estadoSerieCeramica(companyId: string): Promise<SerieCeramica | null> {
  if (typeof (prisma as unknown as { invoiceSeries?: { findUnique?: unknown } }).invoiceSeries?.findUnique !== 'function') return null;
  return describir(await leerSerieB(companyId), false);
}

/**
 * La empresa (española) acaba de quedar con «Vendo cerámica» marcada: crea las
 * series que falten, la B incluida si ninguna serie usa el código B, y dice
 * cómo queda. Una B que ya existe no se toca (ni se activa ni se le cambia la
 * plantilla): el aviso dice qué hacer.
 */
export async function prepararSerieCeramica(companyId: string): Promise<SerieCeramica> {
  const { serieBCreada } = await sembrarSeries(companyId, async () => true);
  return describir(await leerSerieB(companyId), serieBCreada);
}
