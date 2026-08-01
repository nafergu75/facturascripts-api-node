import { asyncHandler } from '../utils/async-handler';
import { sendOk } from '../utils/response';
import { badRequest } from '../utils/http-errors';
import { legalizationService } from '../services/legalizationService';
import { fiscalYearsService } from '../services/fiscalYears.service';
import { assertAccesoEmpresa, leerArtefacto } from '../services/registroMercantil.helpers';
import { registrarAuditoria } from '../services/auditoria.service';

/** Extrae un PDF subido: multipart (multer) o JSON { contenidoBase64 }. */
function extraerPdf(req: { file?: { buffer: Buffer }; body?: unknown }): Buffer {
  if (req.file?.buffer) return req.file.buffer;
  const b = (req.body ?? {}) as Record<string, unknown>;
  if (typeof b.contenidoBase64 === 'string') return Buffer.from(b.contenidoBase64, 'base64');
  throw badRequest('No se recibió el PDF de la diligencia. Usa multipart (campo "archivo") o { contenidoBase64 }.');
}

export const legalizationPackagesController = {
  // POST /fiscal-years/:fyId/legalization-package  body: { bookIds?: [...] }
  crear: asyncHandler(async (req, res) => {
    const fy = await fiscalYearsService.obtener(req.params.fyId);
    assertAccesoEmpresa(req.user, fy.companyId);
    const bookIds = ((req.body ?? {}) as { bookIds?: string[] }).bookIds;
    const paquete = await legalizationService.crearPaquete(fy.id, bookIds);
    await registrarAuditoria({ userId: req.user!.userId, companyId: fy.companyId, action: 'CREATE_LEGALIZATION_PACKAGE', resourceType: 'LEGALIZATION_PACKAGE', resourceId: paquete.packageId });
    sendOk(res, paquete, undefined, 201);
  }),

  // GET /legalization-packages/:packageId/download
  descargar: asyncHandler(async (req, res) => {
    const p = await legalizationService.obtener(req.params.packageId);
    assertAccesoEmpresa(req.user, p.companyId);
    const buf = await leerArtefacto(p.zipPath);
    await registrarAuditoria({ userId: req.user!.userId, companyId: p.companyId, action: 'DOWNLOAD_LEGALIZATION_PACKAGE', resourceType: 'LEGALIZATION_PACKAGE', resourceId: p.id });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="expediente-${p.id}.zip"`);
    res.send(buf);
  }),

  // PATCH /legalization-packages/:packageId  -> status FILED + datos de presentación
  actualizar: asyncHandler(async (req, res) => {
    const p = await legalizationService.obtener(req.params.packageId);
    assertAccesoEmpresa(req.user, p.companyId);
    const actualizado = await legalizationService.actualizarPresentacion(p.id, req.body ?? {});
    await registrarAuditoria({ userId: req.user!.userId, companyId: p.companyId, action: 'FILE_LEGALIZATION_PACKAGE', resourceType: 'LEGALIZATION_PACKAGE', resourceId: p.id, meta: { registryEntryNumber: actualizado.registryEntryNumber } });
    sendOk(res, actualizado);
  }),

  // POST /legalization-packages/:packageId/diligence  (PDF de la diligencia)
  diligencia: asyncHandler(async (req, res) => {
    const p = await legalizationService.obtener(req.params.packageId);
    assertAccesoEmpresa(req.user, p.companyId);
    const pdf = extraerPdf(req as never);
    const actualizado = await legalizationService.guardarDiligencia(p.id, pdf);
    await registrarAuditoria({ userId: req.user!.userId, companyId: p.companyId, action: 'UPLOAD_DILIGENCE', resourceType: 'LEGALIZATION_PACKAGE', resourceId: p.id });
    sendOk(res, actualizado);
  }),
};
