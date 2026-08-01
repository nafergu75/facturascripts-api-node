import { asyncHandler } from '../utils/async-handler';
import { sendOk, sendMessage } from '../utils/response';
import { badRequest } from '../utils/http-errors';
import {
  chartOfAccountsService,
  CrearCuentaDTO,
} from '../services/chart-of-accounts.service';
import { registrarAuditoria } from '../services/auditoria.service';

export const chartOfAccountsController = {
  /**
   * POST /api/accounting/chart-of-accounts/init
   * Inicializar plan contable para una empresa (PGC base).
   */
  inicializar: asyncHandler(async (req, res) => {
    const { companyId, versionPGC, gruposAIncluir } = req.body ?? {};

    if (!companyId) throw badRequest('companyId requerido.');

    await chartOfAccountsService.inicializarPlanContableEmpresa(
      companyId,
      versionPGC || '2021',
      gruposAIncluir || [1, 2, 3, 4, 5, 6, 7],
    );

    await registrarAuditoria({
      userId: req.user?.userId || 'unknown',
      companyId,
      action: 'INICIALIZAR_PLAN_CONTABLE',
      resourceType: 'CHART_OF_ACCOUNTS',
      meta: { versionPGC, gruposAIncluir },
    });

    sendMessage(res, 'Plan contable inicializado correctamente', 201);
  }),

  /**
   * GET /api/accounting/chart-of-accounts
   * Listar plan contable con filtros.
   */
  listar: asyncHandler(async (req, res) => {
    const grupo = req.query.grupo ? Number(req.query.grupo) : undefined;
    const nivel = req.query.nivel ? Number(req.query.nivel) : undefined;
    const naturaleza = req.query.naturaleza as string | undefined;
    const soloActivas = req.query.soloActivas === 'true';

    const cuentas = await chartOfAccountsService.listarPlanContable(
      req.companyId!,
      {
        grupo,
        nivel,
        naturaleza,
        soloActivas,
      },
    );

    sendOk(res, { cuentas, cantidad: cuentas.length });
  }),

  /**
   * GET /api/accounting/chart-of-accounts/arbol
   * Obtener estructura jerárquica completa (árbol).
   */
  obtenerArbol: asyncHandler(async (req, res) => {
    const grupo = req.query.grupo ? Number(req.query.grupo) : undefined;

    const arbol = await chartOfAccountsService.obtenerArbolPlanContable(
      req.companyId!,
      grupo,
    );

    sendOk(res, { arbol });
  }),

  /**
   * GET /api/accounting/chart-of-accounts/:codigo
   * Obtener una cuenta por código.
   */
  obtenerPorCodigo: asyncHandler(async (req, res) => {
    const cuenta = await chartOfAccountsService.obtenerCuentaPorCodigo(
      req.companyId!,
      req.params.codigo,
    );

    sendOk(res, { cuenta });
  }),

  /**
   * POST /api/accounting/chart-of-accounts
   * Crear subcuenta personalizada.
   */
  crearSubcuenta: asyncHandler(async (req, res) => {
    const dto: CrearCuentaDTO = {
      companyId: req.companyId!,
      ...req.body,
    };

    const nueva = await chartOfAccountsService.crearSubcuentaPersonalizada(dto);

    await registrarAuditoria({
      userId: req.user?.userId || 'unknown',
      companyId: req.companyId,
      action: 'CREAR_SUBCUENTA',
      resourceType: 'CHART_OF_ACCOUNTS',
      resourceId: nueva.id,
      meta: { codigo: nueva.codigo, nombre: nueva.nombre },
    });

    sendOk(res, { cuenta: nueva }, undefined, 201);
  }),

  /**
   * PATCH /api/accounting/chart-of-accounts/:id
   * Actualizar cuenta (nombre, activo, notas).
   */
  actualizar: asyncHandler(async (req, res) => {
    const actualizada = await chartOfAccountsService.actualizarCuenta(
      req.params.id,
      req.companyId!,
      req.body,
    );

    await registrarAuditoria({
      userId: req.user?.userId || 'unknown',
      companyId: req.companyId,
      action: 'ACTUALIZAR_CUENTA_CONTABLE',
      resourceType: 'CHART_OF_ACCOUNTS',
      resourceId: req.params.id,
      meta: req.body,
    });

    sendOk(res, { cuenta: actualizada });
  }),
};
