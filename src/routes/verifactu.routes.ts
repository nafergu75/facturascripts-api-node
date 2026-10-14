import { Router, type Request, type RequestHandler } from 'express';
import multer from 'multer';
import { verifactuController } from '../controllers/verifactu.controller';
import { authorize } from '../middleware/authorize.middleware';
import { rateLimit } from '../middleware/rate-limit.middleware';
import { badRequest } from '../utils/http-errors';
import { CERT_MAX_BYTES, MENSAJES_CERTIFICADO } from '../services/verifactu/certificado';

// Montado bajo /companies/:companyId/verifactu (scoped). Lo lee quien ve las
// ventas: el formulario de factura y la lista de Ventas lo usan para avisar y
// para deshabilitar el boton de emitir.
const router = Router({ mergeParams: true });

router.get('/red-seguridad', authorize('ventas:read'), verifactuController.estadoRedEmpresa);

// Exclusion SII o FORAL (spec 9.2): solo un administrador de la empresa, con
// rastro en AuditLog. Marcar el SII en los ajustes fiscales no basta para abrir la red.
router.get('/exclusion', authorize('admin:empresa'), verifactuController.leerExclusion);
router.put('/exclusion', authorize('admin:empresa'), verifactuController.fijarExclusion);

// Configuracion > VERI*FACTU (spec 10.3): la ve el administrador de la empresa.
router.get('/configuracion', authorize('admin:empresa'), verifactuController.configuracion);

// Certificado electronico (spec 2.5): lo sube, sustituye, borra y prueba quien
// tiene config:write (el administrador). 10 intentos cada 10 minutos por
// usuario (en memoria; la prueba de conexion ademas tiene su minuto en la base).
const porUsuario = (req: Request) => `verifactu:${req.user?.userId ?? req.ip ?? 'anonimo'}`;
const limite = () =>
  rateLimit({
    ventanaMs: 10 * 60_000,
    max: 10,
    keyGenerator: porUsuario,
    mensaje: 'Demasiados intentos con el certificado. Espera unos minutos antes de volver a probar.',
    detalles: { codigo: 'VERIFACTU_DEMASIADOS_INTENTOS', code: 'VERIFACTU_DEMASIADOS_INTENTOS' },
  });
const limiteSubida = limite();
const limitePrueba = limite();
// En memoria y con topes: un fichero de 64 KB, la contraseña y «actúa como».
const subida = multer({ storage: multer.memoryStorage(), limits: { fileSize: CERT_MAX_BYTES, files: 1, fields: 3, fieldSize: 1024, parts: 5 } });
/** Los errores de multer, como 400 en el campo del certificado (si no, darian un 500). */
const subirFichero: RequestHandler = (req, res, next) =>
  subida.single('certificado')(req, res, (err?: unknown) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      const grande = err.code === 'LIMIT_FILE_SIZE';
      const codigo = grande ? 'VERIFACTU_CERT_GRANDE' : 'VERIFACTU_CERT_FICHERO';
      return next(badRequest(grande ? MENSAJES_CERTIFICADO.grande : MENSAJES_CERTIFICADO.fichero, { campo: 'certificado', codigo, code: codigo }));
    }
    return next(err);
  });
router.put('/certificado', authorize('config:write'), limiteSubida, subirFichero, verifactuController.subirCertificado);
router.delete('/certificado', authorize('config:write'), verifactuController.borrarCertificado);
router.post('/certificado/probar', authorize('config:write'), limitePrueba, verifactuController.probarConexion);

export default router;
