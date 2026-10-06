import { Router } from 'express';
import multer from 'multer';
import { documentoArchivoController } from '../controllers/documentoArchivo.controller';
import { authorize } from '../middleware/authorize.middleware';

const router = Router({ mergeParams: true });

// Configurar multer para subida de archivos en memoria
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024, // 50 MB máximo
  },
  fileFilter: (req, file, cb) => {
    // Permitir archivos comunes de facturas: PDF, JPG, PNG, TIFF
    const mimePermitidos = [
      'application/pdf',
      'image/jpeg',
      'image/png',
      'image/webp',
      'image/tiff',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'text/plain',
    ];

    if (mimePermitidos.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Tipo de archivo no permitido: ${file.mimetype}`));
    }
  },
});

// POST /companies/:companyId/archivo
// Crear nuevo documento en el archivo
router.post('/', authorize('contabilidad:write'), upload.single('archivo'), documentoArchivoController.crear);

// GET /companies/:companyId/archivo
// Listar documentos por período (con filtros)
router.get('/', authorize('contabilidad:read'), documentoArchivoController.listar);

// --- Archivo de facturas por año y trimestre ---
// NOTA: todas estas rutas van ANTES que /:id para que no las capture.

// GET /companies/:companyId/archivo/arbol
// Años con sus 4 trimestres: nº y total de ventas y de gastos
router.get('/arbol', authorize('contabilidad:read'), documentoArchivoController.arbol);

// GET /companies/:companyId/archivo/trimestre/zip?anio=&trimestre=
// ZIP del trimestre: ventas/*.pdf, gastos/* y resumen.csv
router.get('/trimestre/zip', authorize('contabilidad:read'), documentoArchivoController.trimestreZip);

// GET /companies/:companyId/archivo/trimestre?anio=&trimestre=
// Facturas de venta y de gasto de un trimestre
router.get('/trimestre', authorize('contabilidad:read'), documentoArchivoController.trimestre);

// GET /companies/:companyId/archivo/ventas/:facturaId/pdf
// PDF de una factura de venta (copia archivada o generada al vuelo)
router.get('/ventas/:facturaId/pdf', authorize('contabilidad:read'), documentoArchivoController.pdfVenta);

// POST /companies/:companyId/archivo/regenerar
// Archiva las facturas antiguas que aún no tienen documento
router.post('/regenerar', authorize('contabilidad:write'), documentoArchivoController.regenerar);

// GET /companies/:companyId/archivo/estadisticas/periodo
// Obtener estadísticas de un período
// NOTA: Esta ruta debe ir ANTES que /:id para evitar conflicto
router.get('/estadisticas/periodo', authorize('contabilidad:read'), documentoArchivoController.obtenerEstadisticas);

// GET /companies/:companyId/archivo/buscar
// Buscar documentos por término
// NOTA: Esta ruta debe ir ANTES que /:id para evitar conflicto
router.get('/buscar', authorize('contabilidad:read'), documentoArchivoController.buscar);

// GET /companies/:companyId/archivo/:id
// Obtener detalles de un documento
router.get('/:id', authorize('contabilidad:read'), documentoArchivoController.obtener);

// GET /companies/:companyId/archivo/:id/descargar
// Descargar archivo original
router.get('/:id/descargar', authorize('contabilidad:read'), documentoArchivoController.descargar);

// PATCH /companies/:companyId/archivo/:id/estado
// Actualizar estado de un documento
router.patch('/:id/estado', authorize('contabilidad:write'), documentoArchivoController.actualizarEstado);

// DELETE /companies/:companyId/archivo/:id
// Eliminar/anular un documento
router.delete('/:id', authorize('contabilidad:write'), documentoArchivoController.eliminar);

export default router;
