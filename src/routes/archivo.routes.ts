import { Router } from 'express';
import multer from 'multer';
import { documentoArchivoController } from '../controllers/documentoArchivo.controller';

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
router.post('/', upload.single('archivo'), documentoArchivoController.crear);

// GET /companies/:companyId/archivo
// Listar documentos por período (con filtros)
router.get('/', documentoArchivoController.listar);

// GET /companies/:companyId/archivo/estadisticas/periodo
// Obtener estadísticas de un período
// NOTA: Esta ruta debe ir ANTES que /:id para evitar conflicto
router.get('/estadisticas/periodo', documentoArchivoController.obtenerEstadisticas);

// GET /companies/:companyId/archivo/buscar
// Buscar documentos por término
// NOTA: Esta ruta debe ir ANTES que /:id para evitar conflicto
router.get('/buscar', documentoArchivoController.buscar);

// GET /companies/:companyId/archivo/:id
// Obtener detalles de un documento
router.get('/:id', documentoArchivoController.obtener);

// GET /companies/:companyId/archivo/:id/descargar
// Descargar archivo original
router.get('/:id/descargar', documentoArchivoController.descargar);

// PATCH /companies/:companyId/archivo/:id/estado
// Actualizar estado de un documento
router.patch('/:id/estado', documentoArchivoController.actualizarEstado);

// DELETE /companies/:companyId/archivo/:id
// Eliminar/anular un documento
router.delete('/:id', documentoArchivoController.eliminar);

export default router;
