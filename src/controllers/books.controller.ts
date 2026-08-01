import { asyncHandler } from '../utils/async-handler';
import { sendOk } from '../utils/response';
import { notFound } from '../utils/http-errors';
import { booksService } from '../services/booksService';
import { fiscalYearsService } from '../services/fiscalYears.service';
import { assertAccesoEmpresa, leerArtefacto } from '../services/registroMercantil.helpers';
import { registrarAuditoria } from '../services/auditoria.service';
import { TipoLibro } from '../domain/registroMercantil.model';

export const booksController = {
  // POST /fiscal-years/:fyId/books/generate  body: { tipos: [...] }
  generar: asyncHandler(async (req, res) => {
    const fy = await fiscalYearsService.obtener(req.params.fyId);
    assertAccesoEmpresa(req.user, fy.companyId);
    const body = (req.body ?? {}) as { tipos?: TipoLibro[]; types?: TipoLibro[] };
    const tipos = body.tipos ?? body.types ?? [];
    const libros = await booksService.generar(fy.id, tipos);
    await registrarAuditoria({ userId: req.user!.userId, companyId: fy.companyId, action: 'GENERATE_BOOKS', resourceType: 'LEGAL_BOOK', resourceId: fy.id, meta: { tipos } });
    sendOk(res, libros, undefined, 201);
  }),

  // GET /fiscal-years/:fyId/books
  listar: asyncHandler(async (req, res) => {
    const fy = await fiscalYearsService.obtener(req.params.fyId);
    assertAccesoEmpresa(req.user, fy.companyId);
    sendOk(res, await booksService.listar(fy.id));
  }),

  // GET /books/:bookId/download
  descargar: asyncHandler(async (req, res) => {
    const libro = await booksService.obtener(req.params.bookId);
    if (!libro) throw notFound('Libro no encontrado.');
    assertAccesoEmpresa(req.user, libro.companyId);
    if (!libro.filePath) throw notFound('El libro aún no se ha generado (sin PDF).');
    const buf = await leerArtefacto(libro.filePath);
    await registrarAuditoria({ userId: req.user!.userId, companyId: libro.companyId, action: 'DOWNLOAD_BOOK', resourceType: 'LEGAL_BOOK', resourceId: libro.id });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="libro-${libro.type}.pdf"`);
    res.send(buf);
  }),
};
