import { asyncHandler } from '../utils/async-handler';
import { sendOk } from '../utils/response';
import { annualAccountsService } from '../services/annualAccountsService';
import { fiscalYearsService } from '../services/fiscalYears.service';
import { assertAccesoEmpresa, leerArtefacto } from '../services/registroMercantil.helpers';
import { registrarAuditoria } from '../services/auditoria.service';
import { ModeloCuentas } from '../domain/registroMercantil.model';

export const annualAccountsController = {
  // POST /fiscal-years/:fyId/annual-accounts/generate  body: { modelo?: 'NORMAL'|'ABREVIADO'|'PYME' }
  generar: asyncHandler(async (req, res) => {
    const fy = await fiscalYearsService.obtener(req.params.fyId);
    assertAccesoEmpresa(req.user, fy.companyId);
    const modelo = (((req.body ?? {}) as { modelo?: ModeloCuentas }).modelo ?? 'PYME') as ModeloCuentas;
    const cuenta = await annualAccountsService.generar(fy.id, modelo);
    await registrarAuditoria({ userId: req.user!.userId, companyId: fy.companyId, action: 'GENERATE_ANNUAL_ACCOUNTS', resourceType: 'ANNUAL_ACCOUNTS', resourceId: cuenta.accountId, meta: { modelo } });
    sendOk(res, cuenta, undefined, 201);
  }),

  // GET /fiscal-years/:fyId/annual-accounts
  listar: asyncHandler(async (req, res) => {
    const fy = await fiscalYearsService.obtener(req.params.fyId);
    assertAccesoEmpresa(req.user, fy.companyId);
    sendOk(res, await annualAccountsService.listar(fy.id));
  }),

  // GET /annual-accounts/:id/download
  descargar: asyncHandler(async (req, res) => {
    const c = await annualAccountsService.obtener(req.params.id);
    assertAccesoEmpresa(req.user, c.companyId);
    const buf = await leerArtefacto(c.filePath);
    await registrarAuditoria({ userId: req.user!.userId, companyId: c.companyId, action: 'DOWNLOAD_ANNUAL_ACCOUNTS', resourceType: 'ANNUAL_ACCOUNTS', resourceId: c.id });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="cuentas-anuales-${c.id}.pdf"`);
    res.send(buf);
  }),

  // POST /annual-accounts/:id/filing
  filing: asyncHandler(async (req, res) => {
    const c = await annualAccountsService.obtener(req.params.id);
    assertAccesoEmpresa(req.user, c.companyId);
    const actualizado = await annualAccountsService.registrarPresentacion(c.id, req.body ?? {});
    await registrarAuditoria({ userId: req.user!.userId, companyId: c.companyId, action: 'FILE_ANNUAL_ACCOUNTS', resourceType: 'ANNUAL_ACCOUNTS', resourceId: c.id });
    sendOk(res, actualizado);
  }),

  // POST /annual-accounts/:id/resolution  body: { status: 'APROBADO'|'DEFECTOS'|'RECHAZADO' }
  resolution: asyncHandler(async (req, res) => {
    const c = await annualAccountsService.obtener(req.params.id);
    assertAccesoEmpresa(req.user, c.companyId);
    const status = String(((req.body ?? {}) as { status?: string }).status ?? '');
    const actualizado = await annualAccountsService.registrarResolucion(c.id, status);
    await registrarAuditoria({ userId: req.user!.userId, companyId: c.companyId, action: 'RESOLVE_ANNUAL_ACCOUNTS', resourceType: 'ANNUAL_ACCOUNTS', resourceId: c.id, meta: { status } });
    sendOk(res, actualizado);
  }),
};
