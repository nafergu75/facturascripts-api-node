/**
 * ============================================================================
 * RUTAS DEL LECTOR — LEGACY. Sustituido por income-reader.routes.ts.
 * ============================================================================
 *
 * CORRECCIÓN: el comentario anterior afirmaba "DEAD CODE — no registrado". Es
 * FALSO: estas rutas SÍ están vivas, montadas indirectamente vía
 * `facturas.routes.ts` bajo `/companies/:companyId/facturas/lector`, y las
 * consume el frontend vanilla antiguo (`frontend/`).
 *
 * El lector canónico para nuevas integraciones es income-reader
 * (`/companies/:companyId/income-reader/*`), consumido por el frontend Chakra.
 * Este módulo se mantiene SOLO por compatibilidad con el frontend vanilla; su
 * OCR ya delega en income-reader (ver lectorFacturas.service.ts). No usar para
 * nuevas funcionalidades. Ver ADR "Consolidación de lector OCR".
 *
 * Toda respuesta de estas rutas lleva cabeceras de deprecación (RFC 8594):
 * `Deprecation: true` y `Link: <…/income-reader>; rel="successor-version"`.
 * ============================================================================
 */
import { Router, RequestHandler } from 'express';
import express from 'express';
import multer from 'multer';
import { lectorFacturasController } from '../controllers/lectorFacturas.controller';
import { authorize } from '../middleware/authorize.middleware';

// Montado bajo /companies/:companyId/facturas/lector
const router = Router({ mergeParams: true });

/**
 * Marca toda respuesta de este lector legacy con cabeceras de deprecación, para
 * que clientes y proxies sepan que el sucesor es income-reader. No altera el
 * cuerpo de la respuesta (el frontend vanilla sigue recibiendo lo mismo).
 */
const cabeceraDeprecacion: RequestHandler = (req, res, next) => {
  res.setHeader('Deprecation', 'true');
  res.setHeader('Link', `</companies/${req.params.companyId ?? ':companyId'}/income-reader>; rel="successor-version"`);
  res.setHeader('Warning', '299 - "Lector legacy: usa income-reader (/income-reader). Estas rutas se mantienen solo por compatibilidad con el frontend antiguo."');
  next();
};
router.use(cabeceraDeprecacion);

// Subida multipart (drag&drop del front): campo 'archivo'. En memoria, 15 MB max.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

/**
 * Subida de factura (venta o gasto). Acepta 3 formatos:
 *  - multipart/form-data con campo 'archivo' (multer)
 *  - binario crudo (PDF/imagen/XML) con Content-Type correspondiente
 *  - JSON { nombreArchivo, mimeType, contenidoBase64 }
 */
router.post(
  '/upload',
  authorize('contabilidad:write'),
  upload.single('archivo'),
  express.raw({ type: ['application/pdf', 'image/*', 'application/xml', 'text/xml'], limit: '15mb' }),
  lectorFacturasController.upload,
);

router.get('/', authorize('contabilidad:read'), lectorFacturasController.listar);
router.get('/:id', authorize('contabilidad:read'), lectorFacturasController.detalle);
router.put('/:id', authorize('contabilidad:write'), lectorFacturasController.actualizar);
router.post('/:id/crear-factura', authorize('contabilidad:write'), lectorFacturasController.crearFactura);

export default router;
