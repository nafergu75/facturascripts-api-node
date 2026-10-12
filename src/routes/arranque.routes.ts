import { Router } from 'express';
import multer from 'multer';
import { arranqueController as c } from '../controllers/arranque.controller';
import { partidasController as partidas } from '../controllers/partidas.controller';
import { authorize } from '../middleware/authorize.middleware';
import { badRequest } from '../utils/http-errors';
import { EXTENSIONES_CARGA, MAX_FICHEROS_CARGA } from '../services/arranque/lectorLibros';

/**
 * «Traer la contabilidad de 2026» (/companies/:companyId/arranque).
 *
 * Los ficheros pequeños llegan en el campo «archivos» (multipart); los grandes,
 * por trozos (POST /puesta-en-marcha/subidas) y aqui su «subidaIds». El
 * analisis no escribe nada contable; confirmar e importar son del
 * administrador de la empresa, que siempre puede dar de alta clientes y
 * proveedores.
 */
const router = Router({ mergeParams: true });

const subida = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: MAX_FICHEROS_CARGA },
  fileFilter: (_req, file, cb) => {
    if (EXTENSIONES_CARGA.test(file.originalname)) return cb(null, true);
    cb(badRequest(`«${file.originalname}»: sube los listados en Excel (.xlsx, .xls), CSV, TXT o la tabla de ContaPlus (.dbf).`));
  },
});

router.get('/aviso', authorize('contabilidad:read'), c.aviso);
// Facturas de 2026 pendientes de cobro y de pago (antes de /:ejercicio, que las tomaria por un año).
router.get('/partidas', authorize('ventas:read', 'compras:read', 'tesoreria:read', 'contabilidad:read'), partidas.listar);
router.get('/partidas/:id', authorize('ventas:read', 'compras:read', 'tesoreria:read', 'contabilidad:read'), partidas.detalle);
router.post('/partidas/liquidaciones/:id/anular', authorize('tesoreria:write'), partidas.anular);
router.post('/partidas/:id/liquidar', authorize('tesoreria:write'), partidas.liquidar);
router.get('/:ejercicio', authorize('contabilidad:read'), c.estado);
router.post('/:ejercicio/cargas', authorize('contabilidad:write'), subida.array('archivos', MAX_FICHEROS_CARGA), c.subir);
router.post('/:ejercicio/cargas/:cargaId/analizar', authorize('contabilidad:write'), c.analizar);
router.delete('/:ejercicio/cargas/:cargaId/ficheros/:sha', authorize('contabilidad:write'), c.quitarFichero);
router.post('/:ejercicio/cargas/:cargaId/confirmar', authorize('admin:empresa'), c.confirmar);
router.post('/:ejercicio/cargas/:cargaId/aplicar', authorize('admin:empresa'), c.aplicar);
router.get('/:ejercicio/cargas/:cargaId/deshacer', authorize('contabilidad:read'), c.vistaDeshacer);
router.delete('/:ejercicio/cargas/:cargaId', authorize('admin:empresa'), c.deshacer);
router.get('/:ejercicio/comprobaciones', authorize('contabilidad:read'), c.comprobaciones);
router.post('/:ejercicio/avisos/:clave/aceptar', authorize('admin:empresa'), c.aceptarAviso);
router.put('/:ejercicio/bancos', authorize('tesoreria:write', 'contabilidad:write'), c.bancos);
router.put('/:ejercicio/datos-fiscales', authorize('impuestos:write', 'contabilidad:write'), c.datosFiscales);
router.post('/:ejercicio/series', authorize('ventas:write'), c.series);
router.post('/:ejercicio/ejercicios/llevanza', authorize('admin:empresa'), c.llevanza);

export default router;
