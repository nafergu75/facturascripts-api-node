import { Router, type RequestHandler } from 'express';
import multer from 'multer';
import { nominasController as c } from '../controllers/nominas.controller';
import { nominasConexionesController as x } from '../controllers/nominasConexiones.controller';
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
 *
 * Tesoreria: POST .../pago { fecha?, cuentaBancariaId? | caja? | movimientoId?, nominaIds?, incluirEmbargos? },
 *   POST .../pago/anular; seguros sociales GET/PUT /seguros-sociales/:ejercicio/:mes y .../pago;
 *   111 GET /retenciones/:ejercicio/:periodo y .../pago; GET /prevision; GET /conciliacion/sugerencias.
 * Fiscal: GET /190/:ejercicio/perceptores (JSON o xlsx) y /190/:ejercicio/fichero (TXT AEAT).
 * Archivo: PDF de la gestoria por mes (POST/GET .../documentos), descarga y ZIP. Solo con nominas:read:
 *   el archivo general de facturas no los muestra.
 * Informes: GET /informes/coste?ejercicio&agrupar=mes|empleado&formato=xlsx.
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

/** PDF de la gestoria (o imagen), hasta 4 MB: el limite de una peticion en Vercel. Errores de multer -> 400. */
const MIMES_PDF = ['application/pdf', 'image/jpeg', 'image/png'];
const pdf = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (MIMES_PDF.includes(file.mimetype)) return cb(null, true);
    cb(badRequest('El documento tiene que ser un PDF (o una imagen JPG o PNG).'));
  },
});
const subidaPdf: RequestHandler = (req, res, next) =>
  pdf.single('archivo')(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError) {
      return next(badRequest(err.code === 'LIMIT_FILE_SIZE' ? 'El PDF ocupa más de 4 MB: súbelo por trabajador o comprímelo.' : `Fichero no válido (${err.code}).`));
    }
    next(err as Error | undefined);
  });

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

// Pago de los liquidos (465 de cada trabajador contra 572/570 o un cargo del extracto).
router.post('/periodos/:ejercicio/:mes/pago', authorize('nominas:write'), x.pagar);
router.post('/periodos/:ejercicio/:mes/pago/anular', authorize('nominas:write'), x.anularPago);

// PDF de la gestoria (nominas, RLC, RNT) en el archivo privado.
router.get('/periodos/:ejercicio/:mes/documentos', authorize('nominas:read'), x.listarDocumentosMes);
router.post('/periodos/:ejercicio/:mes/documentos', authorize('nominas:write'), subidaPdf, x.subirDocumento);
router.get('/documentos', authorize('nominas:read'), x.listarDocumentos);
router.get('/documentos/zip', authorize('nominas:read'), x.zipDocumentos);
router.get('/documentos/:documentoId/descargar', authorize('nominas:read'), x.descargarDocumento);
router.delete('/documentos/:documentoId', authorize('nominas:write'), x.anularDocumento);

// Seguros sociales (RLC) y su pago (476 contra 572).
router.get('/seguros-sociales', authorize('nominas:read'), x.listarSegurosSociales);
router.get('/seguros-sociales/:ejercicio/:mes', authorize('nominas:read'), x.obtenerSegurosSociales);
router.put('/seguros-sociales/:ejercicio/:mes', authorize('nominas:write'), x.guardarSegurosSociales);
router.post('/seguros-sociales/:ejercicio/:mes/pago', authorize('nominas:write'), x.pagarSegurosSociales);
router.post('/seguros-sociales/:ejercicio/:mes/pago/anular', authorize('nominas:write'), x.anularPagoSegurosSociales);

// Modelo 111 (misma fuente que Impuestos) y su pago; modelo 190 por perceptor.
router.get('/retenciones/:ejercicio/:periodo', authorize('nominas:read'), x.retenciones);
router.post('/retenciones/:ejercicio/:periodo/pago', authorize('nominas:write'), x.pagar111);
router.post('/retenciones/:ejercicio/:periodo/pago/anular', authorize('nominas:write'), x.anularPago111);
router.get('/190/:ejercicio/perceptores', authorize('nominas:read'), x.perceptores190);
router.get('/190/:ejercicio/fichero', authorize('nominas:read'), x.fichero190);

// Informes y tesoreria.
router.get('/informes/coste', authorize('nominas:read'), x.informeCoste);
router.get('/prevision', authorize('nominas:read'), x.prevision);
router.get('/conciliacion/sugerencias', authorize('nominas:read'), x.sugerencias);

router.get('/:id', authorize('nominas:read'), c.obtener);
router.put('/:id', authorize('nominas:write'), c.actualizar);
router.delete('/:id', authorize('nominas:write'), c.borrar);

export default router;
