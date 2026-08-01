import { Router } from 'express';
import multer from 'multer';
import { fiscalYearsController } from '../controllers/fiscalYears.controller';
import { booksController } from '../controllers/books.controller';
import { legalizationPackagesController } from '../controllers/legalizationPackages.controller';
import { annualAccountsController } from '../controllers/annualAccounts.controller';
import { authorize } from '../middleware/authorize.middleware';

/**
 * Rutas de NIVEL SUPERIOR del Registro Mercantil (no llevan companyId en la URL;
 * el acceso se valida contra la empresa del recurso vía assertAccesoEmpresa).
 * Montadas en el router raíz tras authMiddleware.
 */
const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

// --- Ejercicios contables ---
router.post('/fiscal-years/:fyId/close', authorize('contabilidad:write'), fiscalYearsController.cerrar);
router.get('/fiscal-years/:fyId/deadlines', fiscalYearsController.deadlines);

// --- Libros contables y societarios ---
router.post('/fiscal-years/:fyId/books/generate', authorize('contabilidad:write'), booksController.generar);
router.get('/fiscal-years/:fyId/books', booksController.listar);
router.get('/books/:bookId/download', booksController.descargar);

// --- Expediente de legalización ---
router.post('/fiscal-years/:fyId/legalization-package', authorize('contabilidad:write'), legalizationPackagesController.crear);
router.get('/legalization-packages/:packageId/download', legalizationPackagesController.descargar);
router.patch('/legalization-packages/:packageId', authorize('contabilidad:write'), legalizationPackagesController.actualizar);
router.post('/legalization-packages/:packageId/diligence', authorize('contabilidad:write'), upload.single('archivo'), legalizationPackagesController.diligencia);

// --- Depósito de cuentas anuales ---
router.post('/fiscal-years/:fyId/annual-accounts/generate', authorize('contabilidad:write'), annualAccountsController.generar);
router.get('/fiscal-years/:fyId/annual-accounts', annualAccountsController.listar);
router.get('/annual-accounts/:id/download', annualAccountsController.descargar);
router.post('/annual-accounts/:id/filing', authorize('contabilidad:write'), annualAccountsController.filing);
router.post('/annual-accounts/:id/resolution', authorize('contabilidad:write'), annualAccountsController.resolution);

export default router;
