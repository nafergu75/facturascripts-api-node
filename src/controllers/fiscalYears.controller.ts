import { asyncHandler } from '../utils/async-handler';
import { sendOk } from '../utils/response';
import { fiscalYearsService } from '../services/fiscalYears.service';
import { booksService } from '../services/booksService';
import { annualAccountsService } from '../services/annualAccountsService';
import { assertAccesoEmpresa } from '../services/registroMercantil.helpers';
import { registrarAuditoria } from '../services/auditoria.service';

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
  cerrar: asyncHandler(async (req, res) => {
    const fy = await fiscalYearsService.obtener(req.params.fyId);
    assertAccesoEmpresa(req.user, fy.companyId);
    const cerrado = await fiscalYearsService.cerrar(fy.id, (req.body ?? {}).closingDate);
    await registrarAuditoria({ userId: req.user!.userId, companyId: fy.companyId, action: 'CLOSE_FISCAL_YEAR', resourceType: 'FISCAL_YEAR', resourceId: fy.id, meta: { legalizationDeadline: cerrado.legalizationDeadline } });
    sendOk(res, cerrado);
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
