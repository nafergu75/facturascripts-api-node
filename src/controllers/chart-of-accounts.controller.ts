import { asyncHandler } from '../utils/async-handler';
import { sendOk } from '../utils/response';
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
    // La empresa sale de la ruta (/companies/:companyId/...), ya comprobada contra
    // la sesion. Antes se leia del cuerpo: un admin de una empresa podia
    // inicializar el plan de otra.
    const companyId = req.companyId!;
    const { versionPGC, gruposAIncluir } = req.body ?? {};
    if (gruposAIncluir !== undefined && !Array.isArray(gruposAIncluir)) {
      throw badRequest('gruposAIncluir tiene que ser una lista de grupos (1-7).');
    }

    const resultado = await chartOfAccountsService.asegurarPlanContableEmpresa(
      companyId,
      versionPGC || '2021',
      gruposAIncluir || [1, 2, 3, 4, 5, 6, 7],
    );

    await registrarAuditoria({
      userId: req.user?.userId || 'unknown',
      companyId,
      action: 'INICIALIZAR_PLAN_CONTABLE',
      resourceType: 'CHART_OF_ACCOUNTS',
      meta: { versionPGC, gruposAIncluir, ...resultado },
    });

    sendOk(res, resultado, undefined, 201);
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

    // La primera consulta crea el plan si la empresa aun no lo tiene.
    await chartOfAccountsService.asegurarPlanContableEmpresa(req.companyId!);
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

    // La primera consulta crea el plan si la empresa aun no lo tiene.
    await chartOfAccountsService.asegurarPlanContableEmpresa(req.companyId!);
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
    // companyId va despues: el cuerpo no puede elegir la empresa.
    const dto: CrearCuentaDTO = {
      ...req.body,
      companyId: req.companyId!,
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
