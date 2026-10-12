/**
 * «¿Está bien el arranque?»: Carmen contesta con el nivel de las
 * comprobaciones de «Traer la contabilidad de 2026» (A4): todo correcto,
 * faltan datos (con la lista) o errores. SOLO LECTURA.
 */
import { comprobacionesArranque } from '../../arranque/seguimiento.service';
import { ENLACE_ARRANQUE } from '../../periodos.service';
import { tiene } from '../contexto';
import { plural } from '../plantillas';
import type { CarmenCtx, HuecosResueltos, RespuestaDatos } from '../tipos';

const MAX_PUNTOS = 5;
const ENLACE = { texto: 'Ir a Traer la contabilidad de 2026', href: ENLACE_ARRANQUE };

export async function estadoArranque(ctx: CarmenCtx, _h: HuecosResueltos): Promise<RespuestaDatos> {
  if (!tiene(ctx, 'contabilidad:read')) return { sinPermiso: true, area: 'contabilidad' };
  const entendido = 'Cómo está la contabilidad de 2026 que trajiste de la gestoría';
  if (!ctx.espanola) {
    return { entendido, texto: 'Esta empresa no es española: no hay contabilidad de una gestoría española que traer.', sinCifras: true };
  }
  const a4 = await comprobacionesArranque(ctx.companyId);
  if (!a4) {
    return {
      entendido,
      texto:
        'Todavía no has traído la contabilidad de 2026. En Contabilidad → Traer la contabilidad de 2026 subes los ficheros que te dé la gestoría (plan de cuentas, sumas y saldos, diario, clientes, proveedores, cartera e inmovilizado) y la app los reconoce sola. Conviene hacerlo antes de dar de alta clientes o proveedores.',
      sinCifras: true,
      enlaces: [ENLACE],
    };
  }
  const faltan = a4.puntos.filter((p) => p.nivel === 'FALTA');
  const errores = a4.puntos.filter((p) => p.nivel === 'ERROR');
  const lista = (ps: typeof faltan) => ps.slice(0, MAX_PUNTOS).map((p) => `- ${p.texto}`).join('\n') + (ps.length > MAX_PUNTOS ? `\n- y ${ps.length - MAX_PUNTOS} más.` : '');
  const tipo = a4.carga.tipo === 'DEFINITIVA' ? 'definitiva' : 'provisional';
  const deQue = a4.deBorrador ? 'El resumen que tienes a medias' : `La carga ${tipo} (versión ${a4.carga.version})`;
  let texto: string;
  if (a4.nivel === 'ERRORES') {
    texto = `${deQue} tiene ${plural(errores.length, 'error', 'errores')} y todavía no se puede traer:\n${lista(errores)}`;
  } else if (a4.nivel === 'FALTAN_DATOS') {
    texto = `${deQue}${a4.deBorrador ? ' se puede traer, pero' : ' está traída, pero'} faltan datos:\n${lista(faltan)}`;
  } else {
    texto = a4.deBorrador
      ? 'El resumen está correcto: ya puedes traer la contabilidad de 2026.'
      : `La contabilidad de 2026 está completa y cuadra (carga ${tipo}, versión ${a4.carga.version}). Ya puedes seguir con 2027.`;
  }
  if (!a4.deBorrador && a4.carga.tipo !== 'DEFINITIVA') texto += ' Cuando la gestoría cierre 2026 de verdad, trae el cierre definitivo.';
  return {
    entendido,
    texto,
    permisoRequerido: 'contabilidad:read',
    kpis: [
      { etiqueta: 'Estado', valor: a4.nivel === 'CORRECTO' ? 'Todo correcto' : a4.nivel === 'FALTAN_DATOS' ? 'Faltan datos' : 'Errores' },
      ...(faltan.length ? [{ etiqueta: 'Datos que faltan', valor: String(faltan.length) }] : []),
      ...(errores.length ? [{ etiqueta: 'Errores', valor: String(errores.length) }] : []),
    ],
    enlaces: [ENLACE],
  };
}
