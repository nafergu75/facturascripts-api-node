import { asyncHandler } from '../utils/async-handler';
import { sendOk } from '../utils/response';
import { notFound } from '../utils/http-errors';
import { prisma } from '../config/database';
import { Decimal } from '@prisma/client/runtime/library';
import { perfilEmpresa } from '../services/perfilEmpresa.service';
import { resumenFiscalPeriodo } from '../services/resumenFiscal.service';
import {
  gastosPorProveedorPanel,
  ingresosPorClientePanel,
  limiteUltimas,
  periodoPanel,
  porCategoriaPanel,
  porMesPanel,
  resumenPanel,
  ultimasFacturasPanel,
  type OpcionesPanel,
} from '../services/panel.service';
import { autorizado } from '../services/rbac.service';
import { ejercicioOActual } from '../utils/anios';
import type { Request } from 'express';

/**
 * Lo que ve del panel quien pregunta: el coste de las nominas (dato de
 * personal) solo con permiso de Nominas o de Contabilidad (que ya lo ve en la
 * 640 y la 642); con solo Tesoreria, los gastos van sin nominas y se avisa.
 */
const opcionesPanel = (req: Request, companyId: string): OpcionesPanel => ({
  incluirNominas: !!req.user && autorizado(req.user, companyId, ['nominas:read', 'contabilidad:read']),
});

export const movementsController = {
  // POST /companies/:companyId/movements
  create: asyncHandler(async (req, res) => {
    const { companyId } = req.params;
    const { type, amount, category, description, date, referenceDocument, fiscalYear, status } =
      req.body;

    const movement = await prisma.movement.create({
      data: {
        companyId,
        type,
        amount: new Decimal(amount),
        category,
        description,
        date: new Date(date),
        referenceDocument,
        // El año de la fecha tal como llega (AAAA-MM-DD...), sin pasar por el huso del servidor.
        fiscalYear: fiscalYear || (/^\d{4}-/.test(String(date)) ? Number(String(date).slice(0, 4)) : new Date(date).getFullYear()),
        status: status || 'draft',
      },
    });

    sendOk(res, movement);
  }),

  // GET /companies/:companyId/movements
  list: asyncHandler(async (req, res) => {
    const { companyId } = req.params;
    const { limit = 50, page = 1, type, category } = req.query;

    const skip = (Number(page) - 1) * Number(limit);

    const where: any = { companyId };
    if (type) where.type = String(type);
    if (category) where.category = String(category);

    const movements = await prisma.movement.findMany({
      where,
      take: Number(limit),
      skip,
      orderBy: { date: 'desc' },
    });

    sendOk(res, movements);
  }),

  /**
   * GET /stats/summary?anio=2026[&trimestre=1-4 | &mes=1-12]
   * Resumen del panel sacado de las FACTURAS y las NOMINAS (panel.service), no
   * de la tabla Movement: ingresos (base de las ventas), gastos (base de las
   * facturas de gasto y coste de las nominas), resultado y numero de facturas.
   * Sin anio, el año en curso en España. `movimientosManuales` cuenta los de
   * «Nuevo movimiento», que ya no entran aqui.
   */
  getSummary: asyncHandler(async (req, res) => {
    const companyId = req.companyId ?? req.params.companyId;
    const periodo = periodoPanel(req.query);
    sendOk(res, await resumenPanel(companyId, periodo, opcionesPanel(req, companyId)));
  }),

  /**
   * Resumen fiscal del periodo a partir de las FACTURAS (no de los movimientos):
   * ventas emitidas e IVA repercutido, gastos e IVA soportado, y retenciones.
   * Las mismas facturas que el 303 (ventas FINAL; ni ventas ni gastos en
   * borrador). Las ventas van como en el 303, por su devengo (la fecha de la
   * operacion si la tiene) y una S por su diferencia con la original; los
   * gastos, por la FECHA DE FACTURA, mientras que el 303 los pone en su fecha
   * de registro, asi que un gasto registrado tarde puede caer aqui en otro
   * periodo (resumenFiscal.service).
   * Importes SIEMPRE en la moneda de cuenta (las columnas de siempre), tambien
   * de las facturas emitidas en otra moneda; `monedaCuenta` dice cual es.
   * GET /stats/fiscal?anio=2026[&trimestre=1-4 | &mes=1-12]: el mismo periodo
   * que las graficas del panel, para que las cifras de los dos bloques cuadren.
   */
  getResumenFiscal: asyncHandler(async (req, res) => {
    const companyId = req.companyId ?? req.params.companyId;
    // El mismo periodo que el resto del panel: ?anio y, si se pide, ?trimestre o ?mes.
    const { anio, trimestre, mes, desde, hasta } = periodoPanel(req.query);
    // Importes de las columnas de siempre (moneda de cuenta), via la fuente unica
    // que tambien usa Carmen (resumenFiscal.service).
    const [r, perfil] = await Promise.all([resumenFiscalPeriodo(companyId, desde, hasta), perfilEmpresa(companyId)]);
    sendOk(res, {
      periodo: { anio, trimestre, mes, desde, hasta },
      monedaCuenta: perfil.monedaCuenta,
      // Una empresa no establecida en Espana no lleva IVA ni modelos de la AEAT.
      empresaEspanola: perfil.espanola,
      ventas: r.ventas,
      gastos: r.gastos,
      // Orientativo: el 303 real puede ajustar IVA no deducible, prorrata o compensaciones.
      ivaResultado: r.ivaResultado,
      // Retenciones que la empresa practica en sus gastos (modelo 111/115).
      retencionesAIngresar: r.retencionesAIngresar,
    });
  }),

  /**
   * GET /stats/by-category?anio=2026[&trimestre | &mes]
   * Gastos por cuenta de gasto (3 cifras del PGC, con su nombre) y «Personal»
   * (nominas), de mayor a menor, con su porcentaje sobre el total.
   */
  getByCategory: asyncHandler(async (req, res) => {
    const companyId = req.companyId ?? req.params.companyId;
    const periodo = periodoPanel(req.query);
    sendOk(res, await porCategoriaPanel(companyId, periodo, opcionesPanel(req, companyId)));
  }),

  /**
   * GET /stats/by-month?anio=2026[&trimestre | &mes]
   * Ingresos y gastos de cada mes del periodo (los doce del año si no se pide
   * otro), tengan datos o no.
   */
  getByMonth: asyncHandler(async (req, res) => {
    const companyId = req.companyId ?? req.params.companyId;
    const periodo = periodoPanel(req.query);
    sendOk(res, await porMesPanel(companyId, periodo, opcionesPanel(req, companyId)));
  }),

  /**
   * GET /stats/ingresos-por-cliente?anio=2026[&trimestre | &mes]: base de las
   * ventas por cliente. Tambien con solo Ventas (ventas:read): son sus ventas.
   */
  getIngresosPorCliente: asyncHandler(async (req, res) => {
    const companyId = req.companyId ?? req.params.companyId;
    sendOk(res, await ingresosPorClientePanel(companyId, periodoPanel(req.query)));
  }),

  /** GET /stats/gastos-por-proveedor?anio=2026[&trimestre | &mes]: base de los gastos por proveedor, y las nominas. */
  getGastosPorProveedor: asyncHandler(async (req, res) => {
    const companyId = req.companyId ?? req.params.companyId;
    sendOk(res, await gastosPorProveedorPanel(companyId, periodoPanel(req.query), opcionesPanel(req, companyId)));
  }),

  /**
   * GET /stats/ultimas-facturas?limit=15[&anio=2026]
   * Las ultimas facturas de venta y de gasto, juntas y de la mas reciente a la
   * mas antigua, con el enlace para abrirlas. Sustituye en el panel a
   * GET /movements?limit=15, que sigue listando los movimientos manuales.
   */
  getUltimasFacturas: asyncHandler(async (req, res) => {
    const companyId = req.companyId ?? req.params.companyId;
    const anio = req.query.anio === undefined || String(req.query.anio).trim() === '' ? null : ejercicioOActual(req.query.anio, { campo: 'anio' });
    sendOk(res, await ultimasFacturasPanel(companyId, limiteUltimas(req.query.limit), anio));
  }),

  // PATCH /companies/:companyId/movements/:id
  // Solo un movimiento de la empresa de la ruta: el de otra empresa da 404.
  update: asyncHandler(async (req, res) => {
    const companyId = req.companyId ?? req.params.companyId;
    const { id } = req.params;
    const { type, amount, category, description, date, referenceDocument, status } = req.body;

    const updateData: any = {};
    if (type) updateData.type = type;
    if (amount) updateData.amount = new Decimal(amount);
    if (category) updateData.category = category;
    if (description) updateData.description = description;
    if (date) updateData.date = new Date(date);
    if (referenceDocument !== undefined) updateData.referenceDocument = referenceDocument;
    if (status) updateData.status = status;

    const { count } = await prisma.movement.updateMany({
      where: { id, companyId },
      data: updateData,
    });
    if (count === 0) throw notFound('Movimiento no encontrado.');

    sendOk(res, await prisma.movement.findFirst({ where: { id, companyId } }));
  }),

  // DELETE /companies/:companyId/movements/:id
  // Solo un movimiento de la empresa de la ruta: el de otra empresa da 404.
  delete: asyncHandler(async (req, res) => {
    const companyId = req.companyId ?? req.params.companyId;
    const { id } = req.params;

    const { count } = await prisma.movement.deleteMany({
      where: { id, companyId },
    });
    if (count === 0) throw notFound('Movimiento no encontrado.');

    sendOk(res, { success: true });
  }),
};
