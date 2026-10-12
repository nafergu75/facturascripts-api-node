import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { authorize } from '../middleware/authorize.middleware';
import { rateLimit } from '../middleware/rate-limit.middleware';
import { usuariosEmpresaController as c } from '../controllers/usuariosEmpresa.controller';
import { badRequest } from '../utils/http-errors';

// Configuracion > Usuarios. Montado bajo /companies/:companyId/usuarios
// (scoped: companyScope ya ha comprobado que entra en la empresa).
//
// Todas las rutas piden 'admin:empresa': el perfil Administrador de ESTA
// empresa o el administrador global (que pasa por el atajo de authorize). El
// rol de otra empresa no cuenta. Las reglas de quien puede tocar a quien estan
// en usuariosEmpresa.service.
const router = Router({ mergeParams: true });

/**
 * Valida el cuerpo con Zod. Error 400 con un texto para la persona y el campo
 * en `details.campo` (lo usa el formulario para señalarlo). Una clave que no
 * se admite (esAdminGlobal, password, companyId, permisos...) es un 400.
 */
function validarCuerpo(esquema: z.ZodTypeAny): RequestHandler {
  return (req, _res, next) => {
    const r = esquema.safeParse(req.body ?? {});
    if (r.success) {
      req.body = r.data;
      return next();
    }
    const fallo = r.error.issues[0];
    if (fallo.code === 'unrecognized_keys') {
      const campo = fallo.keys[0];
      return next(badRequest(`Aquí no se admite el dato «${campo}».`, { campo }));
    }
    const campo = String(fallo.path[0] ?? '');
    return next(badRequest(fallo.message, campo ? { campo } : undefined));
  };
}

const texto = (falta: string, malo: string) => z.string({ required_error: falta, invalid_type_error: malo });

const correo = texto('Escribe el correo.', 'El correo no es válido.');
const rol = texto('Elige el rol.', 'El rol no es válido.');
const nombre = texto('Escribe el nombre y apellidos.', 'El nombre no es válido.');
const telefono = texto('Escribe el teléfono.', 'El teléfono no es válido.').nullable();
/** Las areas (Ver/Modificar) se validan en admin.service (esquemaAreas); null = las del perfil. */
const areas = z.unknown();

const esquemaComprobar = z.object({ email: correo }).strict();
const esquemaAlta = z
  .object({ email: correo, nombre: nombre.nullable().optional(), telefono: telefono.optional(), rol, areas: areas.optional() })
  .strict();
const esquemaEdicion = z.object({ rol, areas: areas.optional(), nombre: nombre.optional(), telefono: telefono.optional() }).strict();
const esquemaVacio = z.object({}).strict();

/**
 * «comprobar-correo» dice si un correo tiene usuario en la plataforma, y no deja
 * rastro en AuditLog (el alta si). Con un limite por usuario no sirve para
 * repasar listas de correos. Al escribir el correo la pantalla pregunta una vez
 * por pausa, asi que el uso normal queda muy por debajo.
 */
const comprobacionesPorUsuario = rateLimit({
  ventanaMs: 10 * 60_000,
  max: 60,
  keyGenerator: (req) => `usuario:${req.user?.userId ?? req.ip}`,
  mensaje: 'Has comprobado demasiados correos seguidos. Espera unos minutos y vuelve a probar.',
});

router.get('/', authorize('admin:empresa'), c.listar);
router.get('/catalogo', authorize('admin:empresa'), c.catalogo);
router.post('/comprobar-correo', authorize('admin:empresa'), comprobacionesPorUsuario, validarCuerpo(esquemaComprobar), c.comprobarCorreo);
router.post('/', authorize('admin:empresa'), validarCuerpo(esquemaAlta), c.alta);
router.put('/:userId', authorize('admin:empresa'), validarCuerpo(esquemaEdicion), c.editar);
router.post('/:userId/contrasena-provisional', authorize('admin:empresa'), validarCuerpo(esquemaVacio), c.nuevaContrasena);
router.delete('/:userId', authorize('admin:empresa'), c.quitar);

export default router;
