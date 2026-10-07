import { Router } from 'express';
import multer from 'multer';
import { nominasController as c } from '../controllers/nominas.controller';
import { authorize } from '../middleware/authorize.middleware';
import { badRequest } from '../utils/http-errors';

/**
 * Nominas: /companies/:companyId/nominas. Solo admin y contable (nominas:read /
 * nominas:write): son datos salariales y personales de los trabajadores.
 *
 * Importacion del Excel de la gestoria, sin estado en el servidor:
 *   POST /importar/vista-previa  (archivo o subidaId, mapeo, ejercicio, mes...) -> filas con cuadre y errores
 *   POST /importar               (lo mismo, o "filas" ya revisadas) -> nominas en borrador
 * Ficheros grandes: POST /importar/subidas por trozos y luego "subidaId".
 *
 * Mes: GET /periodos/:ejercicio/:mes, GET .../asiento-preview,
 *      POST .../contabilizar { nominaIds? }, POST .../anular { nominaIds?, fecha?, motivo?, dejarAnuladas? }
 */
const router = Router({ mergeParams: true });

const subida = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (/\.(xlsx|xls|csv|txt)$/i.test(file.originalname)) return cb(null, true);
    cb(badRequest('El fichero tiene que ser un Excel (.xlsx, .xls) o un CSV.'));
  },
});
const trozo = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024, files: 1 } });

router.get('/', authorize('nominas:read'), c.listar);
router.post('/', authorize('nominas:write'), c.crear);

router.get('/plantilla', authorize('nominas:read'), c.plantilla);
router.get('/resumen', authorize('nominas:read'), c.resumen);
router.post('/resumen', authorize('nominas:write'), c.resumenObsoleto);

router.post('/importar/subidas', authorize('nominas:write'), trozo.single('trozo'), c.subirTrozo);
router.delete('/importar/subidas/:subidaId', authorize('nominas:write'), c.descartarSubida);
router.post('/importar/vista-previa', authorize('nominas:write'), subida.single('archivo'), c.vistaPrevia);
router.post('/importar', authorize('nominas:write'), subida.single('archivo'), c.importar);

router.get('/periodos/:ejercicio/:mes', authorize('nominas:read'), c.periodo);
router.get('/periodos/:ejercicio/:mes/asiento-preview', authorize('nominas:read'), c.asientoPreview);
router.post('/periodos/:ejercicio/:mes/contabilizar', authorize('nominas:write'), c.contabilizar);
router.post('/periodos/:ejercicio/:mes/anular', authorize('nominas:write'), c.anular);

router.get('/:id', authorize('nominas:read'), c.obtener);
router.put('/:id', authorize('nominas:write'), c.actualizar);
router.delete('/:id', authorize('nominas:write'), c.borrar);

export default router;
