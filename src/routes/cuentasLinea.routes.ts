/**
 * Cuentas de gasto o de ingreso para las lineas de las facturas
 * (montado en /companies/:companyId/cuentas-linea).
 *
 *  GET  /?tipo=gasto|venta|servicio[&q=][&madre=]  cuentas elegibles del plan (las de
 *       uso contable, 608, 640, 68x..., aparte en `otras` y solo para contabilidad:write)
 *  GET  /nombres?tipo=&codigos=608,6280001         nombre de esas cuentas (tambien las de
 *       uso contable), para la cuenta que ya lleva una linea
 *  GET  /siguiente?tipo=&madre=628                 codigo que recibiria una subcuenta nueva
 *  POST /  { tipo, madre, nombre, codigo? }        crea la subcuenta (201)
 *  (bajo una cuenta de uso contable, /siguiente y POST piden ademas contabilidad:write)
 *
 * Permisos segun el tipo: gastos con compras o contabilidad; ventas y servicios
 * con ventas o contabilidad (lectura para ver, escritura para crear). El
 * administrador siempre puede.
 */
import { Router, type Request } from 'express';
import { authorize } from '../middleware/authorize.middleware';
import { asyncHandler } from '../utils/async-handler';
import { sendOk } from '../utils/response';
import { forbidden } from '../utils/http-errors';
import { autorizado } from '../services/rbac.service';
import { registrarAuditoria } from '../services/auditoria.service';
import {
  crearSubcuentaLinea,
  esCuentaDeUsoContable,
  listarCuentasLinea,
  nombresCuentasLinea,
  PERMISOS_CUENTA_LINEA,
  proponerSubcuenta,
  tipoCuentaLinea,
  type TipoCuentaLinea,
} from '../services/cuentasLinea.service';

const router = Router({ mergeParams: true });

const LEER = ['compras:read', 'compras:write', 'ventas:read', 'ventas:write', 'contabilidad:read', 'contabilidad:write'];
const CREAR = ['compras:write', 'ventas:write', 'contabilidad:write'];

const TEXTO_TIPO: Record<TipoCuentaLinea, string> = { gasto: 'de gastos', venta: 'de ventas', servicio: 'de ventas' };

/** El permiso fino depende del tipo pedido: un usuario de ventas no ve ni crea cuentas de gastos. */
function exigir(req: Request, tipo: TipoCuentaLinea, accion: 'leer' | 'crear'): void {
  const necesarios = PERMISOS_CUENTA_LINEA[tipo][accion];
  if (autorizado(req.user!, req.companyId, necesarios)) return;
  throw forbidden(`No tienes permiso para ${accion === 'leer' ? 'ver' : 'crear'} cuentas ${TEXTO_TIPO[tipo]} en esta empresa. Si lo necesitas, pídeselo al administrador.`, {
    permisos: necesarios,
  });
}

const texto = (v: unknown) => (typeof v === 'string' ? v : undefined);

const digitos = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v).replace(/\D/g, '') : '');

/**
 * Las cuentas de uso contable (630, 640-645, 68, 69, 606/608/609, 706/708/709...)
 * solo las ve quien tiene Contabilidad «Modificar» (GET / las deja fuera); lo
 * mismo para crear una subcuenta bajo ellas o pedir su siguiente codigo.
 */
function exigirSiUsoContable(req: Request, tipo: TipoCuentaLinea, madre: unknown, codigo?: unknown): void {
  const cuentas = [digitos(madre), digitos(codigo)].filter(Boolean);
  if (!cuentas.some((c) => esCuentaDeUsoContable(c, tipo))) return;
  if (autorizado(req.user!, req.companyId, ['contabilidad:write'])) return;
  throw forbidden('Esa cuenta es de uso contable: solo la puede usar quien lleva la contabilidad. Pídeselo al administrador.', {
    permisos: ['contabilidad:write'],
    campo: 'madre',
  });
}

router.get(
  '/',
  authorize(...LEER),
  asyncHandler(async (req, res) => {
    const tipo = tipoCuentaLinea(req.query.tipo);
    exigir(req, tipo, 'leer');
    const verUsoContable = autorizado(req.user!, req.companyId, ['contabilidad:write']);
    sendOk(res, await listarCuentasLinea(req.companyId!, tipo, { q: texto(req.query.q), madre: texto(req.query.madre) }, { verUsoContable }));
  }),
);

router.get(
  '/nombres',
  authorize(...LEER),
  asyncHandler(async (req, res) => {
    const tipo = tipoCuentaLinea(req.query.tipo);
    exigir(req, tipo, 'leer');
    sendOk(res, await nombresCuentasLinea(req.companyId!, tipo, req.query.codigos));
  }),
);

router.get(
  '/siguiente',
  authorize(...LEER),
  asyncHandler(async (req, res) => {
    const tipo = tipoCuentaLinea(req.query.tipo);
    exigir(req, tipo, 'leer');
    exigirSiUsoContable(req, tipo, req.query.madre);
    sendOk(res, await proponerSubcuenta(req.companyId!, tipo, req.query.madre));
  }),
);

router.post(
  '/',
  authorize(...CREAR),
  asyncHandler(async (req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const tipo = tipoCuentaLinea(b.tipo);
    exigir(req, tipo, 'crear');
    exigirSiUsoContable(req, tipo, b.madre, b.codigo);
    const sub = await crearSubcuentaLinea(req.companyId!, { tipo, madre: b.madre, nombre: b.nombre, codigo: b.codigo });
    await registrarAuditoria({
      userId: req.user!.userId,
      companyId: req.companyId,
      action: 'CREATE_SUBCUENTA',
      resourceType: 'SUBCUENTA',
      resourceId: sub.id,
      after: sub,
    });
    sendOk(res, sub, undefined, 201);
  }),
);

export default router;
