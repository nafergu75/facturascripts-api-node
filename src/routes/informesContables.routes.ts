/**
 * Informes contables descargables: /companies/:companyId/informes-contables/...
 *
 * Periodo: ?ejercicio=AAAA (año completo) o ?desde=AAAA-MM-DD&hasta=AAAA-MM-DD
 * dentro de un mismo ejercicio. Formato: ?formato=json (por defecto), pdf o xlsx.
 *
 *   GET /ejercicios                        años con asientos
 *   GET /balance                           balance de situacion PYMES con N-1
 *   GET /perdidas-ganancias                PyG PYMES con N-1
 *   GET /sumas-saldos?nivel=subcuenta|3|4  balance de sumas y saldos
 *   GET /mayor?cuenta=572 | ?cuentaDesde=600&cuentaHasta=629
 *   GET /diario?incluirCierre=1
 *   GET /terceros/:tipo?soloConSaldo=1&q=   tipo = clientes | proveedores
 *   GET /terceros/:tipo/:terceroId
 */
import { Router, type Response } from 'express';
import { authorize } from '../middleware/authorize.middleware';
import { asyncHandler } from '../utils/async-handler';
import { sendOk } from '../utils/response';
import { badRequest } from '../utils/http-errors';
import { resolverPeriodo, type FiltroCuentas, type NivelSumas, type Periodo, type TipoTercero } from '../services/informesContables.calculo';
import { nombreFichero, tablaAPdf, tablaAXlsx, type TablaInforme } from '../services/informesContables.documentos';
import {
  buscarTerceros,
  ejerciciosDisponibles,
  informeBalance,
  informeDetalleTercero,
  informeDiario,
  informeMayor,
  informeMayorTerceros,
  informePerdidasGanancias,
  informeSumasYSaldos,
  terceroParaMayor,
} from '../services/informesContables.service';

export const informesContablesRoutes = Router({ mergeParams: true });

function periodo(query: Record<string, unknown>): Periodo {
  const p = resolverPeriodo(query);
  if (typeof p === 'string') throw badRequest(p);
  return p;
}

const si = (v: unknown) => v === '1' || v === 'true' || v === 'si';

/** Responde el informe en JSON o lo descarga en PDF / Excel. */
async function responder(res: Response, formato: unknown, informe: { tabla: TablaInforme }) {
  if (formato === 'pdf') {
    const pdf = await tablaAPdf(informe.tabla);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${nombreFichero(informe.tabla.fichero, 'pdf')}"`);
    return res.send(pdf);
  }
  if (formato === 'xlsx' || formato === 'excel') {
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${nombreFichero(informe.tabla.fichero, 'xlsx')}"`);
    return res.send(tablaAXlsx(informe.tabla));
  }
  if (formato && formato !== 'json') throw badRequest('Formato no válido. Usa json, pdf o xlsx.');
  return sendOk(res, informe);
}

const soloDigitos = (v: unknown) => (typeof v === 'string' ? v.replace(/\D/g, '') : '') || undefined;

/** Filtro de cuentas de la consulta: cuenta (prefijo) o rango cuentaDesde/cuentaHasta. */
function filtroCuentas(query: Record<string, unknown>): FiltroCuentas | undefined {
  const filtro = { cuenta: soloDigitos(query.cuenta), desde: soloDigitos(query.cuentaDesde), hasta: soloDigitos(query.cuentaHasta) };
  if (filtro.desde && filtro.hasta && filtro.desde > filtro.hasta) throw badRequest('La cuenta inicial es mayor que la final.');
  return filtro.cuenta || filtro.desde || filtro.hasta ? filtro : undefined;
}

/** cliente | proveedor (tambien admite clientes | proveedores). */
function tipoFicha(v: unknown): 'cliente' | 'proveedor' {
  if (v === 'cliente' || v === 'clientes') return 'cliente';
  if (v === 'proveedor' || v === 'proveedores') return 'proveedor';
  throw badRequest('Indica si es un cliente o un proveedor (tipoTercero=cliente o proveedor).');
}

function tipoTercero(v: string): TipoTercero {
  if (v !== 'clientes' && v !== 'proveedores') throw badRequest('Tipo no válido. Usa clientes o proveedores.');
  return v;
}

informesContablesRoutes.get(
  '/ejercicios',
  authorize('contabilidad:read'),
  asyncHandler(async (req, res) => {
    sendOk(res, await ejerciciosDisponibles(req.companyId!));
  }),
);

informesContablesRoutes.get(
  '/balance',
  authorize('contabilidad:read'),
  asyncHandler(async (req, res) => {
    await responder(res, req.query.formato, await informeBalance(req.companyId!, periodo(req.query)));
  }),
);

informesContablesRoutes.get(
  '/perdidas-ganancias',
  authorize('contabilidad:read'),
  asyncHandler(async (req, res) => {
    await responder(res, req.query.formato, await informePerdidasGanancias(req.companyId!, periodo(req.query)));
  }),
);

informesContablesRoutes.get(
  '/sumas-saldos',
  authorize('contabilidad:read'),
  asyncHandler(async (req, res) => {
    const n = String(req.query.nivel ?? 'subcuenta');
    const nivel: NivelSumas = n === '3' ? 3 : n === '4' ? 4 : 'subcuenta';
    const ocultar = req.query.ocultarSinMovimiento;
    await responder(
      res,
      req.query.formato,
      await informeSumasYSaldos(req.companyId!, periodo(req.query), nivel, {
        filtro: filtroCuentas(req.query),
        ocultarSinMovimiento: ocultar === undefined || ocultar === '' ? true : si(ocultar),
      }),
    );
  }),
);

informesContablesRoutes.get(
  '/mayor',
  authorize('contabilidad:read'),
  asyncHandler(async (req, res) => {
    // Un cliente o proveedor (su subcuenta) o una cuenta o rango de cuentas.
    const terceroId = typeof req.query.tercero === 'string' && req.query.tercero.trim() ? req.query.tercero.trim() : null;
    const tercero = terceroId ? await terceroParaMayor(req.companyId!, tipoFicha(req.query.tipoTercero), terceroId) : undefined;
    const filtro = filtroCuentas(req.query);
    if (!tercero && !filtro) throw badRequest('Indica una cuenta (p. ej. 572), un rango de cuentas o un cliente o proveedor.');
    await responder(res, req.query.formato, await informeMayor(req.companyId!, periodo(req.query), filtro ?? {}, tercero));
  }),
);

/** Buscador de clientes y proveedores por nombre, NIF o subcuenta (para el Libro mayor). */
informesContablesRoutes.get(
  '/buscar-tercero',
  authorize('contabilidad:read'),
  asyncHandler(async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    const tipo = req.query.tipo === undefined || req.query.tipo === '' ? undefined : tipoFicha(req.query.tipo);
    sendOk(res, await buscarTerceros(req.companyId!, q, tipo));
  }),
);

informesContablesRoutes.get(
  '/diario',
  authorize('contabilidad:read'),
  asyncHandler(async (req, res) => {
    await responder(res, req.query.formato, await informeDiario(req.companyId!, periodo(req.query), si(req.query.incluirCierre)));
  }),
);

informesContablesRoutes.get(
  '/terceros/:tipo',
  authorize('contabilidad:read'),
  asyncHandler(async (req, res) => {
    const informe = await informeMayorTerceros(req.companyId!, tipoTercero(req.params.tipo), periodo(req.query), {
      soloConSaldo: si(req.query.soloConSaldo),
      q: typeof req.query.q === 'string' ? req.query.q : undefined,
    });
    await responder(res, req.query.formato, informe);
  }),
);

informesContablesRoutes.get(
  '/terceros/:tipo/:terceroId',
  authorize('contabilidad:read'),
  asyncHandler(async (req, res) => {
    const informe = await informeDetalleTercero(req.companyId!, tipoTercero(req.params.tipo), periodo(req.query), req.params.terceroId);
    await responder(res, req.query.formato, informe);
  }),
);
