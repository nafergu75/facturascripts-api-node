import { Router } from 'express';
import { z } from 'zod';
import { authController } from '../controllers/auth.controller';
import { validate } from '../middleware/validation.middleware';
import { porEmail, rateLimit } from '../middleware/rate-limit.middleware';
import { authMiddleware } from '../middleware/auth.middleware';

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

// Con sesion: usuario y permisos actuales (el menu se refresca con esto).
router.get('/me', authMiddleware, authController.me);

export default router;
