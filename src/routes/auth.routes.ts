import { Router } from 'express';
import { z } from 'zod';
import { authController } from '../controllers/auth.controller';
import { validate } from '../middleware/validation.middleware';
import { porEmail, rateLimit } from '../middleware/rate-limit.middleware';
import { authMiddlewarePermitiendoProvisional } from '../middleware/auth.middleware';

const router = Router();

// Anti fuerza-bruta sobre credenciales: 10 intentos/min por IP (OWASP API2).
const authLimit = rateLimit({ ventanaMs: 60_000, max: 10 });

// Segunda capa, por CUENTA: el limite por IP no frena el brute-force
// distribuido (N IPs contra un mismo email). Solo cuenta intentos fallidos,
// asi el uso legitimo nunca agota la cuota.
const loginPorCuenta = rateLimit({
  ventanaMs: 15 * 60_000,
  max: 10,
  keyGenerator: porEmail,
  soloFallos: true,
  mensaje: 'Demasiados intentos fallidos para esta cuenta, intentalo mas tarde.',
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  // Opcional: "codigo de acceso" de empresa. Si no se envia, el front elige
  // luego entre la lista de empresas devuelta en la respuesta del login.
  empresaCodigo: z.string().optional(),
});

// Publicas
router.get('/health', authController.health);
// loginPorCuenta va DESPUES de validate: asi la clave se construye sobre un
// email ya validado y los payloads malformados no comparten un mismo cubo.
router.post('/login', authLimit, validate(loginSchema), loginPorCuenta, authController.login);
router.post('/dev-login', authLimit, authController.devLogin);
router.post('/refresh', authLimit, authController.refresh);
router.post('/logout', authLimit, authController.logout);

// Con sesion: usuario y permisos actuales (el menu se refresca con esto). Responde
// tambien con contrasena provisional: el frontend sabe asi que debe pedir cambiarla.
router.get('/me', authMiddlewarePermitiendoProvisional, authController.me);

// Cambio de la contrasena PROPIA: la provisional obligatoria y, cuando exista,
// desde Configuracion. Pide la actual; cualquier otro campo del cuerpo es un 400.
const cambiarContrasenaSchema = z
  .object({
    actual: z.string().min(1).max(128),
    nueva: z.string().min(1).max(128),
  })
  .strict();

// Limitador PROPIO por IP: authLimit lo comparten login, refresh y logout y
// sumaria intentos de cosas distintas en el mismo cubo.
const cambioPorIp = rateLimit({ ventanaMs: 60_000, max: 10 });

// Por usuario y solo fallos: frena probar contrasenas con una sesion robada.
const cambioPorUsuario = rateLimit({
  ventanaMs: 15 * 60_000,
  max: 10,
  soloFallos: true,
  keyGenerator: (req) => `usuario:${req.user?.userId ?? req.ip}`,
  mensaje: 'Demasiados intentos. Espera unos minutos y vuelve a probar.',
});

router.post(
  '/cambiar-contrasena',
  cambioPorIp,
  authMiddlewarePermitiendoProvisional,
  validate(cambiarContrasenaSchema),
  cambioPorUsuario,
  authController.cambiarContrasena,
);

export default router;
