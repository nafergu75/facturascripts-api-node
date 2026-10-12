/**
 * Facturas de 2026 pendientes de cobro y de pago (partidas de «Traer la
 * contabilidad de 2026»): lista, ficha, cobrar o pagar, anular y conciliar con
 * un movimiento del banco.
 *
 * Quien solo tiene Ventas ve las de cobro; quien solo tiene Compras, las de
 * pago; con Tesoreria o Contabilidad, las dos.
 */
import type { Request } from 'express';
import { asyncHandler } from '../utils/async-handler';
import { sendOk } from '../utils/response';
import { badRequest } from '../utils/http-errors';
import { autorizado } from '../services/rbac.service';
import {
  anularLiquidacion,
  conciliarMovimientoConPartida,
  detallePartida,
  liquidarPartida,
  listarPartidas,
  type TipoPartida,
} from '../services/arranque/partidas.service';

function tiposVisibles(req: Request): TipoPartida[] {
  const puede = (p: string) => autorizado(req.user!, req.companyId, [p]);
  if (puede('tesoreria:read') || puede('contabilidad:read')) return ['COBRO', 'PAGO'];
  return [...(puede('ventas:read') ? (['COBRO'] as const) : []), ...(puede('compras:read') ? (['PAGO'] as const) : [])];
}

export const partidasController = {
  /** GET /arranque/partidas?tipo=COBRO|PAGO&estado=&tercero=&q= */
  listar: asyncHandler(async (req, res) => {
    const visibles = tiposVisibles(req);
    const tipo = typeof req.query.tipo === 'string' ? req.query.tipo.toUpperCase() : '';
    const tipos = tipo === 'COBRO' || tipo === 'PAGO' ? visibles.filter((t) => t === tipo) : visibles;
    sendOk(res, await listarPartidas(req.companyId!, { tipos, estado: req.query.estado, tercero: req.query.tercero, q: req.query.q }));
  }),

  /** GET /arranque/partidas/:id */
  detalle: asyncHandler(async (req, res) => {
    sendOk(res, await detallePartida(req.companyId!, req.params.id, tiposVisibles(req)));
  }),

  /** POST /arranque/partidas/:id/liquidar — { fecha, importe?, comision?, cuentaBancariaId? | caja: true, nota? } */
  liquidar: asyncHandler(async (req, res) => {
    sendOk(res, await liquidarPartida(req.companyId!, req.params.id, req.body ?? {}, req.user!.userId), undefined, 201);
  }),

  /** POST /arranque/partidas/liquidaciones/:id/anular — { fecha? } (solo si el mes del cobro está bloqueado). */
  anular: asyncHandler(async (req, res) => {
    sendOk(res, await anularLiquidacion(req.companyId!, req.params.id, { fecha: (req.body ?? {}).fecha }, req.user!.userId));
  }),

  /** POST /bancos/movimientos/:movId/conciliar-partida — { partidaId } */
  conciliar: asyncHandler(async (req, res) => {
    const partidaId = String((req.body ?? {}).partidaId ?? '').trim();
    if (!partidaId) throw badRequest('Elige la factura pendiente con la que casar el movimiento.', { campo: 'partidaId' });
    sendOk(res, await conciliarMovimientoConPartida(req.companyId!, req.params.movId, partidaId, req.user!.userId), undefined, 201);
  }),
};
