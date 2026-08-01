/**
 * AEAT LEGACY (spine FacturaScripts; lee asientos/facturas de FS). Sucesor
 * canónico: /impuestos (módulo fiscal Prisma, usado por el Chakra). OJO: la
 * MIGRACIÓN de la fuente de datos (FS → JournalEntry) está PENDIENTE — ver
 * ADR-002, Paso 3. Marcar como legacy no migra los datos; solo señala dirección.
 */
import { Router } from 'express';
import { aeatController } from '../controllers/aeat.controller';
import { authorize } from '../middleware/authorize.middleware';
import { deprecacion } from '../middleware/deprecation.middleware';

const router = Router({ mergeParams: true });
router.use(deprecacion('/companies/:companyId/impuestos'));

// Todos los modelos AEAT requieren permiso de lectura contable/AEAT (OWASP API5: BFLA)
router.use(authorize('aeat:read'));

// Preview (JSON) de cada modelo. Query: ejercicio, periodo (1T..4T/01..12/0A).
router.get('/modelo-303/preview', aeatController.preview303);
router.get('/modelo-390/preview', aeatController.preview390);
router.get('/modelo-347/preview', aeatController.preview347);
router.get('/modelo-349/preview', aeatController.preview349);
router.get('/modelo-111/preview', aeatController.preview111);
router.get('/modelo-111/fichero', aeatController.fichero111);
router.get('/modelo-115/preview', aeatController.preview115);
router.get('/modelo-115/fichero', aeatController.fichero115);

// Ficheros BOE (text/plain descargable). Layout provisional hasta tener el
// diseño de registros oficial AEAT. Query: ejercicio, periodo, nif.
router.get('/modelo-303/fichero', aeatController.fichero303);
router.get('/modelo-390/fichero', aeatController.fichero390);
router.get('/modelo-347/fichero', aeatController.fichero347);
router.get('/modelo-349/fichero', aeatController.fichero349);

export default router;
