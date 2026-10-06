import { Router } from 'express';
import multer from 'multer';
import { puestaEnMarchaController as c } from '../controllers/puestaEnMarcha.controller';
import { authorize } from '../middleware/authorize.middleware';
import { badRequest } from '../utils/http-errors';

/**
 * Puesta en marcha: importar balance (asiento de apertura), libro diario/mayor
 * del ejercicio en curso y saldos de ejercicios anteriores (comparativo).
 * Las peticiones llevan el fichero (o los datos ya mapeados), o el id de una
 * subida por trozos para los ficheros grandes (se borra al confirmar).
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

// Trozos de ficheros grandes (Vercel corta peticiones de mas de ~4,5 MB).
const trozo = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024, files: 1 } });

router.get('/', authorize('contabilidad:read'), c.estado);

/**
 * Subida por trozos: POST /subidas (campo "trozo" + indice, total; el primero
 * con nombre y tamano, los demas con el subidaId que devuelve el primero).
 * Despues, las vistas previas y confirmaciones aceptan "subidaId" en vez de "archivo".
 */
router.post('/subidas', authorize('contabilidad:write'), trozo.single('trozo'), c.subirTrozo);
router.delete('/subidas/:subidaId', authorize('contabilidad:write'), c.descartarSubida);

router.post('/apertura/vista-previa', authorize('contabilidad:write'), subida.single('archivo'), c.vistaApertura);
router.post('/apertura', authorize('contabilidad:write'), subida.single('archivo'), c.confirmarApertura);
router.delete('/apertura', authorize('contabilidad:write'), c.anularApertura);

router.post('/diario/vista-previa', authorize('contabilidad:write'), subida.single('archivo'), c.vistaDiario);
router.post('/diario', authorize('contabilidad:write'), subida.single('archivo'), c.confirmarDiario);
router.delete('/diario', authorize('contabilidad:write'), c.anularDiario);

router.post('/comparativo/vista-previa', authorize('contabilidad:write'), subida.single('archivo'), c.vistaComparativo);
router.post('/comparativo', authorize('contabilidad:write'), subida.single('archivo'), c.confirmarComparativo);
router.delete('/comparativo/:ejercicio', authorize('contabilidad:write'), c.borrarComparativo);

export default router;
