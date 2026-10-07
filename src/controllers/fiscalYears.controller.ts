import { asyncHandler } from '../utils/async-handler';
import { sendOk } from '../utils/response';
import { fiscalYearsService } from '../services/fiscalYears.service';
import { booksService } from '../services/booksService';
import { annualAccountsService } from '../services/annualAccountsService';
import { assertAccesoEmpresa } from '../services/registroMercantil.helpers';
import { registrarAuditoria } from '../services/auditoria.service';
import { conflict } from '../utils/http-errors';

export const MENSAJE_CIERRE_EN_OTRA_PANTALLA =
  'El ejercicio ya no se cierra desde aquí. Ciérralo en Contabilidad > Cierre y traspaso de saldos: allí se hacen la regularización, el cierre y la apertura del año siguiente, y se puede deshacer.';

const ESTADOS_LIBRO = ['PENDING', 'GENERATED', 'PACKAGE_READY', 'FILED', 'ACCEPTED', 'REJECTED'];
const ESTADOS_CUENTAS = ['DRAFT', 'READY', 'FILED', 'APROBADO', 'DEFECTOS', 'RECHAZADO'];

export const fiscalYearsController = {
  // --- Scoped: /companies/:companyId/fiscal-years ---
  listar: asyncHandler(async (req, res) => {
    sendOk(res, await fiscalYearsService.listar(req.companyId!));
  }),

  crear: asyncHandler(async (req, res) => {
    const fy = await fiscalYearsService.crear(req.companyId!, req.body ?? {});
    await registrarAuditoria({ userId: req.user!.userId, companyId: req.companyId, action: 'CREATE_FISCAL_YEAR', resourceType: 'FISCAL_YEAR', resourceId: fy.id });
    sendOk(res, fy, undefined, 201);
  }),

  // --- Top-level: /fiscal-years/:fyId/... (acceso validado vía la empresa del recurso) ---
  /**
   * POST /fiscal-years/:fyId/close (Registro Mercantil). Ya no cierra: marcaba el
   * ejercicio como cerrado sin regularizar, sin asientos de cierre ni apertura, y
   * despues no se podia deshacer. El cierre se hace siempre en Contabilidad >
   * Cierre y traspaso de saldos (POST /companies/:id/periodos/cierre), que deja
   * tambien la fecha de cierre, los plazos y los libros pendientes.
   */
  cerrar: asyncHandler(async (req) => {
    const fy = await fiscalYearsService.obtener(req.params.fyId);
    assertAccesoEmpresa(req.user, fy.companyId);
    throw conflict(MENSAJE_CIERRE_EN_OTRA_PANTALLA, { enlace: `/dashboard/contabilidad/cierre-ejercicio?ejercicio=${fy.label}` });
  }),

  deadlines: asyncHandler(async (req, res) => {
    const fy = await fiscalYearsService.obtener(req.params.fyId);
    assertAccesoEmpresa(req.user, fy.companyId);
    const [libros, cuentas] = await Promise.all([booksService.listar(fy.id), annualAccountsService.listar(fy.id)]);
    sendOk(res, {
      fiscalYearId: fy.id,
      estado: fy.estado,
      closingDate: fy.closingDate,
      legalizationDeadline: fy.legalizationDeadline,
      accountsDepositDeadline: fy.accountsDepositDeadline,
      estadosLibrosPosibles: ESTADOS_LIBRO,
      estadosCuentasPosibles: ESTADOS_CUENTAS,
      libros: libros.map((b) => ({ id: b.id, type: b.type, status: b.status })),
      cuentas: cuentas.map((c) => ({ id: c.id, status: c.status })),
    });
  }),
};
