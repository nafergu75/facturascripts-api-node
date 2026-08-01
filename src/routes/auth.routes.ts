import { Router } from 'express';
import { z } from 'zod';
import { authController } from '../controllers/auth.controller';
import { validate } from '../middleware/validation.middleware';
import { rateLimit } from '../middleware/rate-limit.middleware';

const router = Router();

// Anti fuerza-bruta sobre credenciales: 10 intentos/min por IP (OWASP API2).
const authLimit = rateLimit({ ventanaMs: 60_000, max: 10 });

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  // Opcional: "codigo de acceso" de empresa. Si no se envia, el front elige
  // luego entre la lista de empresas devuelta en la respuesta del login.
  empresaCodigo: z.string().optional(),
});

// Publicas
router.get('/health', authController.health);
router.post('/login', authLimit, validate(loginSchema), authController.login);
router.post('/dev-login', authController.devLogin);
router.post('/refresh', authLimit, authController.refresh);
router.post('/logout', authLimit, authController.logout);

export default router;
