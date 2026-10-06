import { RequestParamHandler, Router } from 'express';
import multer from 'multer';
import { fiscalYearsController } from '../controllers/fiscalYears.controller';
import { booksController } from '../controllers/books.controller';
import { legalizationPackagesController } from '../controllers/legalizationPackages.controller';
import { annualAccountsController } from '../controllers/annualAccounts.controller';
import { authorize } from '../middleware/authorize.middleware';
import { notFound } from '../utils/http-errors';
import { assertAccesoEmpresa } from '../services/registroMercantil.helpers';
import { fiscalYearsService } from '../services/fiscalYears.service';
import { booksService } from '../services/booksService';
import { legalizationService } from '../services/legalizationService';
import { annualAccountsService } from '../services/annualAccountsService';

/**
 * Rutas de NIVEL SUPERIOR del Registro Mercantil (no llevan companyId en la URL;
 * el acceso se valida contra la empresa del recurso vía assertAccesoEmpresa).
 * Montadas en el router raíz tras authMiddleware.
 */
const router = Router();

// Antes de comprobar permisos, cada ruta averigua la empresa del recurso y la
// deja en req.companyId. Asi authorize() usa los roles del usuario EN ESA
// empresa: sin esto se usaban sus roles globales y alguien que es contable en
// una empresa y solo lectura en otra podia cerrar el ejercicio de la segunda.
function empresaDelRecurso(cargar: (id: string) => Promise<{ companyId: string } | null>): RequestParamHandler {
  return async (req, _res, next, id: string) => {
    try {
      const recurso = await cargar(id);
      if (!recurso) throw notFound('Recurso no encontrado.');
      assertAccesoEmpresa(req.user, recurso.companyId);
      req.companyId = recurso.companyId;
      next();
    } catch (e) {
      next(e);
    }
  };
}
router.param('fyId', empresaDelRecurso((id) => fiscalYearsService.obtener(id)));
router.param('bookId', empresaDelRecurso((id) => booksService.obtener(id)));
router.param('packageId', empresaDelRecurso((id) => legalizationService.obtener(id)));
router.param('id', empresaDelRecurso((id) => annualAccountsService.obtener(id)));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

// --- Ejercicios contables ---
router.post('/fiscal-years/:fyId/close', authorize('contabilidad:write'), fiscalYearsController.cerrar);
router.get('/fiscal-years/:fyId/deadlines', fiscalYearsController.deadlines);

// --- Libros contables y societarios ---
router.post('/fiscal-years/:fyId/books/generate', authorize('contabilidad:write'), booksController.generar);
router.get('/fiscal-years/:fyId/books', booksController.listar);
router.get('/books/:bookId/download', booksController.descargar);

// --- Expediente de legalización ---
router.get('/fiscal-years/:fyId/legalization-packages', legalizationPackagesController.listar);
router.post('/fiscal-years/:fyId/legalization-package', authorize('contabilidad:write'), legalizationPackagesController.crear);
router.get('/legalization-packages/:packageId/download', legalizationPackagesController.descargar);
router.patch('/legalization-packages/:packageId', authorize('contabilidad:write'), legalizationPackagesController.actualizar);
router.post('/legalization-packages/:packageId/diligence', authorize('contabilidad:write'), upload.single('archivo'), legalizationPackagesController.diligencia);

// --- Depósito de cuentas anuales ---
router.post('/fiscal-years/:fyId/annual-accounts/generate', authorize('contabilidad:write'), annualAccountsController.generar);
router.get('/fiscal-years/:fyId/annual-accounts', annualAccountsController.listar);
router.get('/fiscal-years/:fyId/memoria', annualAccountsController.memoria);
router.put('/fiscal-years/:fyId/memoria', authorize('contabilidad:write'), annualAccountsController.guardarMemoria);
router.get('/annual-accounts/:id/download', annualAccountsController.descargar);
router.get('/annual-accounts/:id/xbrl', annualAccountsController.descargarXbrl);
router.post('/annual-accounts/:id/filing', authorize('contabilidad:write'), annualAccountsController.filing);
router.post('/annual-accounts/:id/resolution', authorize('contabilidad:write'), annualAccountsController.resolution);

export default router;
